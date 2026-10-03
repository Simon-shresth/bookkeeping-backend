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

// Invoices are never modified by payments (so editing/deleting either stays
// safe). Instead, at report time each party's payments are applied to their
// oldest credit invoices first (FIFO); whatever is left on an invoice is
// what's still outstanding. Payments beyond total invoices (advances) simply
// don't appear as an invoice row.
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

function summarize(rows) {
  const buckets = { Current: 0, '1-30': 0, '31-60': 0, '61+': 0 };
  for (const r of rows) buckets[r.bucket] += r.outstanding;
  return buckets;
}

// GET /api/reports/ar-aging
router.get('/ar-aging', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    const { rows: invoices } = await pool.query(
      `select s.id, s.date::text as date, s.invoice_number, c.id as party_id, c.name as customer, s.total, s.credit_amount
       from sales_invoices s join customers c on c.id = s.customer_id
       where s.company_id=$1 and s.credit_amount > 0
       order by s.date, s.created_at`,
      [companyId]
    );
    // Only payments NOT already linked to a specific invoice go into the
    // FIFO pool below — a linked payment (the upfront amount paid at the
    // time of invoicing) is already netted into that invoice's own
    // credit_amount, so including it here would subtract it twice.
    const { rows: paid } = await pool.query(
      `select customer_id, sum(amount) as total from payments
       where company_id=$1 and type='customer_receipt' and sales_invoice_id is null group by customer_id`,
      [companyId]
    );
    const paidByParty = Object.fromEntries(paid.map((p) => [p.customer_id, Number(p.total)]));
    const rows = applyFifo(invoices, paidByParty).map(({ party_id, credit_amount, ...r }) => r);
    res.json({ rows, buckets: summarize(rows) });
  } catch (err) { next(err); }
});

// GET /api/reports/ap-aging
router.get('/ap-aging', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    const { rows: invoices } = await pool.query(
      `select p.id, p.date::text as date, p.invoice_number, p.pragyapan_number, s.id as party_id, s.name as supplier, p.total, p.credit_amount
       from purchase_invoices p join suppliers s on s.id = p.supplier_id
       where p.company_id=$1 and p.credit_amount > 0
       order by p.date, p.created_at`,
      [companyId]
    );
    const { rows: paid } = await pool.query(
      `select supplier_id, sum(amount) as total from payments
       where company_id=$1 and type='supplier_payment' and purchase_invoice_id is null group by supplier_id`,
      [companyId]
    );
    const paidByParty = Object.fromEntries(paid.map((p) => [p.supplier_id, Number(p.total)]));
    const rows = applyFifo(invoices, paidByParty).map(({ party_id, credit_amount, ...r }) => r);
    res.json({ rows, buckets: summarize(rows) });
  } catch (err) { next(err); }
});

module.exports = router;
