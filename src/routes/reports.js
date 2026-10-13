const express = require('express');
const { pool } = require('../db');
const { getTotals, getBalanceSheet } = require('../services/ledger');

const router = express.Router();

// GET /api/reports/profit-and-loss
router.get('/profit-and-loss', async (req, res, next) => {
  try {
    const t = await getTotals(req.user.company_id);
    res.json({
      revenue: t.revenue,
      costOfGoodsSold: t.cogs,
      operatingExpenses: t.expenseTotal,
      netProfit: t.profit,
    });
  } catch (err) { next(err); }
});

// GET /api/reports/balance-sheet
router.get('/balance-sheet', async (req, res, next) => {
  try {
    res.json(await getBalanceSheet(req.user.company_id));
  } catch (err) { next(err); }
});

function bucketFor(days) {
  if (days <= 0) return 'Current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  return '61+';
}

function applyFifo(invoices, paidByParty) {
  const remaining = { ...paidByParty };
  const today = Date.now();
  const rows = [];
  for (const inv of invoices) {
    const credit = Number(inv.credit_amount);
    const avail = remaining[inv.party_id] || 0;
    const applied = Math.min(avail, credit);
    remaining[inv.party_id] = avail - applied;
    const outstanding = Math.round((credit - applied) * 100) / 100;
    if (outstanding > 0.004) {
      const ageDays = Math.floor((today - new Date(inv.date).getTime()) / 86400000);
      rows.push({ ...inv, original: credit, outstanding, age_days: ageDays, bucket: bucketFor(ageDays) });
    }
  }
  return rows;
}

function ageRow(row, days) {
  const age_days = days;
  const bucket = bucketFor(age_days);
  return { ...row, age_days, bucket };
}

function summarize(rows) {
  const buckets = { Current: 0, '1-30': 0, '31-60': 0, '61+': 0 };
  for (const r of rows) buckets[r.bucket] += r.outstanding;
  return buckets;
}

// Helper: get journal movements with dynamic party field alias ('customer' or 'supplier')
async function getJournalMovements(client, companyId, partyTable, idCol, excludedSources, partyField) {
  const placeholders = excludedSources.map((_, idx) => `$${idx + 2}`).join(',');
  const query = `
    select je.id, je.date::text as date, je.memo, je.reference, je.source,
           s.id as party_id, s.name as ${partyField},
           sum(jl.credit - jl.debit) as amount
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    join ${partyTable} s on s.${idCol} = jl.account_id and s.company_id = je.company_id
    where je.company_id = $1
      and je.source NOT IN (${placeholders})
    group by je.id, je.date, je.memo, je.reference, je.source, s.id, s.name
    having abs(sum(jl.credit - jl.debit)) > 0.004
    order by je.date, je.created_at
  `;
  const values = [companyId, ...excludedSources];
  const { rows } = await client.query(query, values);
  return rows.map(r => ({
    ...r,
    amount: Number(r.amount),
    original: Number(r.amount),
    outstanding: Number(r.amount),
    age_days: null,
    bucket: null,
    kind: 'journal'
  }));
}

// GET /api/reports/ar-aging
router.get('/ar-aging', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;

    const { rows: invoices } = await client.query(
      `select s.id, s.date::text as date, s.invoice_number, c.id as party_id, c.name as customer, s.total, s.credit_amount
       from sales_invoices s join customers c on c.id = s.customer_id
       where s.company_id=$1 and s.credit_amount > 0
       order by s.date, s.created_at`,
      [companyId]
    );
    const { rows: paid } = await client.query(
      `select customer_id, sum(amount) as total from payments
       where company_id=$1 and type='customer_receipt' and sales_invoice_id is null group by customer_id`,
      [companyId]
    );
    const paidByParty = Object.fromEntries(paid.map((p) => [p.customer_id, Number(p.total)]));
    const invoiceRows = applyFifo(invoices, paidByParty).map(({ party_id, credit_amount, ...r }) => ({
      ...r,
      kind: 'invoice',
    }));

    const journalRows = await getJournalMovements(client, companyId, 'customers', 'account_id', ['Sale', 'Payment'], 'customer');

    const allRows = [...invoiceRows, ...journalRows];
    const rowsWithAge = allRows.map(row => {
      const today = Date.now();
      const ageDays = row.age_days !== null ? row.age_days :
        Math.floor((today - new Date(row.date).getTime()) / 86400000);
      return ageRow(row, ageDays);
    });
    const buckets = summarize(rowsWithAge);

    res.json({ rows: rowsWithAge, buckets });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/reports/ap-aging
router.get('/ap-aging', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;

    const { rows: invoices } = await client.query(
      `select p.id, p.date::text as date, p.invoice_number, p.pragyapan_number, s.id as party_id, s.name as supplier, p.total, p.credit_amount
       from purchase_invoices p join suppliers s on s.id = p.supplier_id
       where p.company_id=$1 and p.credit_amount > 0
       order by p.date, p.created_at`,
      [companyId]
    );
    const { rows: paid } = await client.query(
      `select supplier_id, sum(amount) as total from payments
       where company_id=$1 and type='supplier_payment' and purchase_invoice_id is null group by supplier_id`,
      [companyId]
    );
    const paidByParty = Object.fromEntries(paid.map((p) => [p.supplier_id, Number(p.total)]));
    const invoiceRows = applyFifo(invoices, paidByParty).map(({ party_id, credit_amount, ...r }) => ({
      ...r,
      kind: 'invoice',
    }));

    // Passed 'supplier' so rows correctly contain the supplier property expected by the frontend
    const journalRows = await getJournalMovements(client, companyId, 'suppliers', 'account_id', ['Purchase', 'Payment'], 'supplier');

    const allRows = [...invoiceRows, ...journalRows];
    const rowsWithAge = allRows.map(row => {
      const today = Date.now();
      const ageDays = row.age_days !== null ? row.age_days :
        Math.floor((today - new Date(row.date).getTime()) / 86400000);
      return ageRow(row, ageDays);
    });
    const buckets = summarize(rowsWithAge);

    res.json({ rows: rowsWithAge, buckets });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;