const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { audit } = require('../services/audit');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Petty cash balance helpers ────────────────────────────────────────────────

// Opening balance = sum of all INFLOW - OUTFLOW entries BEFORE entry_date
async function getOpeningBalance(client, companyId, beforeDate) {
  const { rows } = await client.query(
    `select
       coalesce(sum(case when type = 'INFLOW'  then amount else 0 end), 0) as inflows,
       coalesce(sum(case when type = 'OUTFLOW' then amount else 0 end), 0) as outflows
     from day_book_entries
     where company_id = $1 and entry_date < $2`,
    [companyId, beforeDate]
  );
  return Number(rows[0].inflows) - Number(rows[0].outflows);
}

// ── GET /api/daybook?date=YYYY-MM-DD ──────────────────────────────────────────
// Returns:
//   - Multi-line cash entries for the date (from day_book_entries)
//   - Opening petty cash balance (prior entries)
//   - Today's total inflows / outflows
//   - Closing balance = opening + inflows - outflows
// Also includes a "journal" section (existing behaviour) for the GL view.
router.get('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);

    // 1. Petty cash day book entries for the day
    const { rows: entries } = await client.query(
      `select dbe.id, dbe.entry_date::text as entry_date, dbe.type,
              dbe.amount, dbe.narration, dbe.created_at,
              a.name as account_name, a.heading, a.category
       from day_book_entries dbe
       join accounts a on a.id = dbe.account_id
       where dbe.company_id = $1 and dbe.entry_date = $2
       order by dbe.created_at asc`,
      [companyId, date]
    );

    // 2. Opening balance (sum of all prior day_book_entries)
    const openingBalance = await getOpeningBalance(client, companyId, date);

    // 3. Today's totals
    const totalInflows  = entries.filter((e) => e.type === 'INFLOW' ).reduce((s, e) => s + Number(e.amount), 0);
    const totalOutflows = entries.filter((e) => e.type === 'OUTFLOW').reduce((s, e) => s + Number(e.amount), 0);
    const closingBalance = openingBalance + totalInflows - totalOutflows;

    // 4. GL journal view (unchanged from original — kept for the transaction history section)
    const { rows: journalEntries } = await client.query(
      `select
         je.id, je.date::text as date, je.source, je.memo, je.reference, je.created_at,
         coalesce(sum(jl.debit), 0)  as total_debit,
         coalesce(sum(jl.credit), 0) as total_credit
       from journal_entries je
       left join journal_lines jl on jl.journal_entry_id = je.id
       where je.company_id = $1 and je.date = $2
       group by je.id, je.date, je.source, je.memo, je.reference, je.created_at
       order by je.created_at asc`,
      [companyId, date]
    );

    // Fetch GL line detail
    const entryIds = journalEntries.map((e) => e.id);
    let linesByEntry = {};
    if (entryIds.length) {
      const { rows: lines } = await client.query(
        `select jl.journal_entry_id, jl.account_id, a.name as account_name,
                a.heading, a.category, jl.debit, jl.credit
         from journal_lines jl
         join accounts a on a.id = jl.account_id
         where jl.journal_entry_id = any($1::uuid[])
         order by jl.id`,
        [entryIds]
      );
      for (const l of lines) (linesByEntry[l.journal_entry_id] ||= []).push(l);
    }

    const glEntries = journalEntries.map((e) => {
      const lines = linesByEntry[e.id] || [];
      const arApLine = lines.find((l) => l.heading === 'Accounts Receivable' || l.heading === 'Accounts Payable');
      const party = arApLine?.account_name || null;
      const typeMap = { Sale: 'SALE', Purchase: 'PURCHASE', Expense: 'EXPENSE', Salary: 'EXPENSE', Payment: e.memo?.toLowerCase().includes('received') ? 'RECEIPT' : 'PAYMENT', Manual: 'JOURNAL', 'Opening Balance': 'JOURNAL' };
      return {
        id: e.id, date: e.date, transaction_type: typeMap[e.source] || 'JOURNAL',
        source: e.source, ref_no: e.reference || null, party,
        narration: e.memo, debit: Number(e.total_debit), credit: Number(e.total_credit), lines,
      };
    });

    const glTotalDebit  = glEntries.reduce((s, e) => s + e.debit,  0);
    const glTotalCredit = glEntries.reduce((s, e) => s + e.credit, 0);

    res.json({
      date,
      // Petty cash book
      entries: entries.map((e) => ({ ...e, amount: Number(e.amount) })),
      summary: {
        opening_balance:  openingBalance,
        total_inflows:    totalInflows,
        total_outflows:   totalOutflows,
        closing_balance:  closingBalance,
        entry_count:      entries.length,
      },
      // General ledger view (existing journal-based data)
      gl: {
        entries:      glEntries,
        total_debit:  glTotalDebit,
        total_credit: glTotalCredit,
        entry_count:  glEntries.length,
      },
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

// ── POST /api/daybook ─────────────────────────────────────────────────────────
// Accepts an array of cash flow lines; all inserted atomically.
// Body: { date: 'YYYY-MM-DD', lines: [{ accountId, type, amount, narration }] }
const lineSchema = z.object({
  accountId: z.string().uuid(),
  type:      z.enum(['INFLOW', 'OUTFLOW']),
  amount:    z.number().positive(),
  narration: z.string().optional(),
});

const postSchema = z.object({
  date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(lineSchema).min(1, 'At least one line is required.'),
});

router.post('/', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    const body = postSchema.parse(req.body);
    const date = body.date || new Date().toISOString().slice(0, 10);

    const inserted = await withTransaction(async (client) => {
      const rows = [];
      for (const line of body.lines) {
        // Verify account belongs to this company
        const { rows: accs } = await client.query(
          'select id, name from accounts where id=$1 and company_id=$2',
          [line.accountId, companyId]
        );
        if (!accs[0]) { const e = new Error(`Account not found: ${line.accountId}`); e.status = 404; throw e; }

        const { rows: [row] } = await client.query(
          `insert into day_book_entries (company_id, entry_date, account_id, type, amount, narration, created_by)
           values ($1,$2,$3,$4,$5,$6,$7) returning *`,
          [companyId, date, line.accountId, line.type, line.amount, line.narration || null, req.user.id]
        );
        rows.push({ ...row, account_name: accs[0].name });
      }
      await audit(client, {
        companyId, userId: req.user.id, action: 'create',
        entity: 'day_book_entries', entityId: rows[0]?.id,
        details: { date, lineCount: rows.length },
      });
      return rows;
    });

    res.status(201).json({ inserted: inserted.length, entries: inserted });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validation failed', details: err.errors });
    next(err);
  }
});

// ── DELETE /api/daybook/:id ───────────────────────────────────────────────────
// Remove a single petty cash entry by id.
router.delete('/:id', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    const { rowCount } = await pool.query(
      'delete from day_book_entries where id=$1 and company_id=$2',
      [req.params.id, companyId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
