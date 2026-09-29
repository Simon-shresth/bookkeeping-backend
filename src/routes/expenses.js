const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { postJournal, reverseJournalEntry } = require('../services/ledger');
const { audit } = require('../services/audit');
const { companyToday } = require('../services/dates');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select e.*, ca.name as category_name, pa.name as account_name
       from expenses e
       join accounts ca on ca.id = e.category_account_id
       join accounts pa on pa.id = e.payment_account_id
       where e.company_id=$1 order by e.date desc, e.created_at desc`,
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const schema = z.object({
  categoryAccountId: z.string().uuid(),
  note: z.string().optional(),
  amount: z.number().positive(),
  paymentAccountId: z.string().uuid(),
});

async function createExpenseWithinTx(client, companyId, userId, body) {
  const catRes = await client.query('select name from accounts where id=$1 and company_id=$2', [body.categoryAccountId, companyId]);
  if (!catRes.rows[0]) { const e = new Error('Category account not found'); e.status = 404; throw e; }

  const date = await companyToday(client, companyId);
  const memo = `${catRes.rows[0].name} expense${body.note ? ' — ' + body.note : ''}`;
  const lines = [
    { accountId: body.categoryAccountId, debit: body.amount, credit: 0 },
    { accountId: body.paymentAccountId, debit: 0, credit: body.amount },
  ];
  const entry = await postJournal(client, { companyId, date, memo, source: 'Expense', lines, createdBy: userId });

  const { rows } = await client.query(
    `insert into expenses (company_id, category_account_id, note, amount, payment_account_id, journal_entry_id, date, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [companyId, body.categoryAccountId, body.note || null, body.amount, body.paymentAccountId, entry?.id || null, date, userId]
  );
  return rows[0];
}

async function reverseExpenseWithinTx(client, companyId, expenseId) {
  const { rows } = await client.query('select * from expenses where id=$1 and company_id=$2', [expenseId, companyId]);
  const expense = rows[0];
  if (!expense) return null;
  await reverseJournalEntry(client, expense.journal_entry_id);
  await client.query('delete from expenses where id = $1', [expenseId]);
  return expense;
}

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const body = schema.parse(req.body);
    const expense = await withTransaction(async (client) => {
      const x = await createExpenseWithinTx(client, req.user.company_id, req.user.id, body);
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'create', entity: 'expense', entityId: x.id, details: { amount: x.amount, note: x.note } });
      return x;
    });
    res.status(201).json(expense);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const body = schema.parse(req.body);
    const expense = await withTransaction(async (client) => {
      const old = await reverseExpenseWithinTx(client, req.user.company_id, req.params.id);
      if (!old) { const e = new Error('Not found'); e.status = 404; throw e; }
      const x = await createExpenseWithinTx(client, req.user.company_id, req.user.id, body);
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'update', entity: 'expense', entityId: x.id, details: { replaced: old.id, before: { amount: old.amount }, after: { amount: x.amount } } });
      return x;
    });
    res.json(expense);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const expense = await withTransaction(async (client) => {
      const old = await reverseExpenseWithinTx(client, req.user.company_id, req.params.id);
      if (old) await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'delete', entity: 'expense', entityId: old.id, details: { amount: old.amount, note: old.note } });
      return old;
    });
    if (!expense) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
