const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { audit } = require('../services/audit');
const { companyToday } = require('../services/dates');

const router = express.Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getBankAccount(db, companyId, accountId) {
  if (!UUID.test(String(accountId))) return null;
  const { rows } = await db.query(
    "select id, name from accounts where id=$1 and company_id=$2 and heading='Bank'",
    [accountId, companyId]
  );
  return rows[0] || null;
}

// Net effect on the bank balance of everything already cleared (bank is an
// asset, so debits increase it and credits decrease it).
async function clearedBalance(db, companyId, accountId) {
  const { rows } = await db.query(
    `select coalesce(sum(jl.debit - jl.credit), 0) as bal
     from journal_lines jl join journal_entries je on je.id = jl.journal_entry_id
     where jl.account_id = $1 and je.company_id = $2 and jl.reconciliation_id is not null`,
    [accountId, companyId]
  );
  return Number(rows[0].bal);
}

// GET /api/reconciliation/accounts — bank accounts with their last reconciliation
router.get('/accounts', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select a.id, a.name,
         (select r.statement_date from bank_reconciliations r where r.account_id = a.id order by r.statement_date desc, r.created_at desc limit 1) as last_statement_date,
         (select r.statement_balance from bank_reconciliations r where r.account_id = a.id order by r.statement_date desc, r.created_at desc limit 1) as last_statement_balance
       from accounts a where a.company_id = $1 and a.heading = 'Bank' order by a.name`,
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/reconciliation/history?accountId=
router.get('/history', async (req, res, next) => {
  try {
    const params = [req.user.company_id];
    let where = 'where r.company_id = $1';
    if (req.query.accountId) { params.push(req.query.accountId); where += ' and r.account_id = $2'; }
    const { rows } = await pool.query(
      `select r.id, r.account_id, a.name as account_name, r.statement_date, r.statement_balance, r.created_at,
         (select count(*) from journal_lines jl where jl.reconciliation_id = r.id)::int as line_count,
         not exists (
           select 1 from bank_reconciliations r2
           where r2.account_id = r.account_id and (r2.statement_date, r2.created_at) > (r.statement_date, r.created_at)
         ) as is_latest
       from bank_reconciliations r join accounts a on a.id = r.account_id
       ${where} order by r.statement_date desc, r.created_at desc`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/reconciliation/:accountId/lines?asOf=YYYY-MM-DD
// Uncleared transactions on or before the statement date, plus the balance
// already cleared by earlier reconciliations.
router.get('/:accountId/lines', async (req, res, next) => {
  try {
    const asOf = DATE.test(req.query.asOf || '') ? req.query.asOf : await companyToday(pool, req.user.company_id);
    const account = await getBankAccount(pool, req.user.company_id, req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Bank account not found' });

    const { rows: lines } = await pool.query(
      `select jl.id, je.date, je.memo, je.reference, je.source, jl.debit, jl.credit
       from journal_lines jl join journal_entries je on je.id = jl.journal_entry_id
       where jl.account_id = $1 and je.company_id = $2 and jl.reconciliation_id is null and je.date <= $3
       order by je.date asc, je.created_at asc`,
      [account.id, req.user.company_id, asOf]
    );
    res.json({ account, asOf, clearedBalance: await clearedBalance(pool, req.user.company_id, account.id), lines });
  } catch (err) { next(err); }
});

const finishSchema = z.object({
  accountId: z.string().uuid(),
  statementDate: z.string().regex(DATE),
  statementBalance: z.number(),
  lineIds: z.array(z.string().uuid()).min(1, 'Select at least one transaction that appears on the statement.'),
});

// POST /api/reconciliation — finish a reconciliation. The statement balance
// must equal (already-cleared balance + the selected lines), i.e. the
// difference must be zero; otherwise nothing is saved.
router.post('/', requireRole('accountant'), async (req, res, next) => {
  try {
    const body = finishSchema.parse(req.body);
    const result = await withTransaction(async (client) => {
      const account = await getBankAccount(client, req.user.company_id, body.accountId);
      if (!account) { const e = new Error('Bank account not found'); e.status = 404; throw e; }

      const { rows: picked } = await client.query(
        `select jl.id, jl.debit, jl.credit
         from journal_lines jl join journal_entries je on je.id = jl.journal_entry_id
         where jl.id = any($1::uuid[]) and jl.account_id = $2 and je.company_id = $3
           and jl.reconciliation_id is null and je.date <= $4
         for update of jl`,
        [body.lineIds, account.id, req.user.company_id, body.statementDate]
      );
      if (picked.length !== body.lineIds.length) {
        const e = new Error('Some selected transactions are unavailable (already cleared, dated after the statement, or from another account). Reload and try again.');
        e.status = 409; throw e;
      }

      const prior = await clearedBalance(client, req.user.company_id, account.id);
      const selectedNet = picked.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
      const difference = Math.round((body.statementBalance - (prior + selectedNet)) * 100) / 100;
      if (Math.abs(difference) > 0.005) {
        const e = new Error(`Doesn't balance yet — the difference is ${difference.toFixed(2)}. Tick the transactions that appear on the statement until it is 0.00.`);
        e.status = 400; throw e;
      }

      const rec = await client.query(
        `insert into bank_reconciliations (company_id, account_id, statement_date, statement_balance, created_by)
         values ($1,$2,$3,$4,$5) returning *`,
        [req.user.company_id, account.id, body.statementDate, body.statementBalance, req.user.id]
      );
      await client.query('update journal_lines set reconciliation_id = $1 where id = any($2::uuid[])', [rec.rows[0].id, body.lineIds]);
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'create', entity: 'bank_reconciliation', entityId: rec.rows[0].id, details: { account: account.name, statementDate: body.statementDate, statementBalance: body.statementBalance, lines: body.lineIds.length } });
      return rec.rows[0];
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// DELETE /api/reconciliation/:id — undo. Only the most recent reconciliation
// for an account can be undone, so cleared history is always contiguous.
router.delete('/:id', requireRole('accountant'), async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query('select * from bank_reconciliations where id=$1 and company_id=$2', [req.params.id, req.user.company_id]);
      const rec = rows[0];
      if (!rec) { const e = new Error('Not found'); e.status = 404; throw e; }
      // Compared inside SQL: round-tripping created_at through a JS Date would
      // drop microseconds and make a row look "later" than itself.
      const later = await client.query(
        `select 1 from bank_reconciliations r2
         join bank_reconciliations r on r.id = $1
         where r2.account_id = r.account_id
           and (r2.statement_date, r2.created_at) > (r.statement_date, r.created_at)
         limit 1`,
        [rec.id]
      );
      if (later.rows[0]) { const e = new Error('Only the most recent reconciliation for this account can be undone. Undo the later one first.'); e.status = 409; throw e; }
      await client.query('delete from bank_reconciliations where id = $1', [rec.id]); // FK sets lines' reconciliation_id back to null
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'delete', entity: 'bank_reconciliation', entityId: rec.id, details: { statementDate: rec.statement_date, statementBalance: rec.statement_balance } });
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
