const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { postJournal, reverseJournalEntry } = require('../services/ledger');
const { audit } = require('../services/audit');
const { companyToday } = require('../services/dates');

const router = express.Router();

// GET /api/payments?type=customer_receipt|supplier_payment
router.get('/', async (req, res, next) => {
  try {
    const params = [req.user.company_id];
    let where = 'where p.company_id = $1';
    if (req.query.type === 'customer_receipt' || req.query.type === 'supplier_payment') {
      params.push(req.query.type);
      where += ' and p.type = $2';
    }
    const { rows } = await pool.query(
      `select p.*, c.name as customer_name, s.name as supplier_name, a.name as account_name
       from payments p
       left join customers c on c.id = p.customer_id
       left join suppliers s on s.id = p.supplier_id
       join accounts a on a.id = p.account_id
       ${where}
       order by p.date desc, p.created_at desc`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const schema = z.object({
  type: z.enum(['customer_receipt', 'supplier_payment']),
  partyId: z.string().uuid(),
  amount: z.number().positive(),
  accountId: z.string().uuid(), // the Cash/Bank account money moves through
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reference: z.string().optional(), // cheque / transfer number
});

async function createPaymentWithinTx(client, companyId, userId, body) {
  const acct = await client.query(
    "select id from accounts where id=$1 and company_id=$2 and heading in ('Cash','Bank')",
    [body.accountId, companyId]
  );
  if (!acct.rows[0]) { const e = new Error('Choose a Cash or Bank account.'); e.status = 400; throw e; }

  const isReceipt = body.type === 'customer_receipt';
  const party = await client.query(
    `select id, name, account_id from ${isReceipt ? 'customers' : 'suppliers'} where id=$1 and company_id=$2`,
    [body.partyId, companyId]
  );
  if (!party.rows[0]) { const e = new Error(isReceipt ? 'Customer not found' : 'Supplier not found'); e.status = 404; throw e; }

  const date = body.date || await companyToday(client, companyId);
  const lines = isReceipt
    ? [{ accountId: body.accountId, debit: body.amount, credit: 0 }, { accountId: party.rows[0].account_id, debit: 0, credit: body.amount }]
    : [{ accountId: party.rows[0].account_id, debit: body.amount, credit: 0 }, { accountId: body.accountId, debit: 0, credit: body.amount }];
  const memo = isReceipt ? `Payment received from ${party.rows[0].name}` : `Payment to ${party.rows[0].name}`;

  const entry = await postJournal(client, { companyId, date, memo, source: 'Payment', reference: body.reference, lines, createdBy: userId });

  const { rows } = await client.query(
    `insert into payments (company_id, type, customer_id, supplier_id, amount, account_id, journal_entry_id, date, created_by, reference)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [companyId, body.type, isReceipt ? body.partyId : null, isReceipt ? null : body.partyId, body.amount, body.accountId, entry?.id || null, date, userId, body.reference || null]
  );
  return rows[0];
}

async function reversePaymentWithinTx(client, companyId, paymentId) {
  const { rows } = await client.query('select * from payments where id=$1 and company_id=$2', [paymentId, companyId]);
  const payment = rows[0];
  if (!payment) return null;
  await reverseJournalEntry(client, payment.journal_entry_id);
  await client.query('delete from payments where id = $1', [paymentId]);
  return payment;
}

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const body = schema.parse(req.body);
    const payment = await withTransaction(async (client) => {
      const p = await createPaymentWithinTx(client, req.user.company_id, req.user.id, body);
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'create', entity: 'payment', entityId: p.id, details: { type: p.type, amount: p.amount, reference: p.reference } });
      return p;
    });
    res.status(201).json(payment);
  } catch (err) { next(err); }
});

router.put('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const body = schema.parse(req.body);
    const payment = await withTransaction(async (client) => {
      const old = await reversePaymentWithinTx(client, req.user.company_id, req.params.id);
      if (!old) { const e = new Error('Not found'); e.status = 404; throw e; }
      const p = await createPaymentWithinTx(client, req.user.company_id, req.user.id, body);
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'update', entity: 'payment', entityId: p.id, details: { replaced: old.id, before: { amount: old.amount, date: old.date }, after: { amount: p.amount, date: p.date } } });
      return p;
    });
    res.json(payment);
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const removed = await withTransaction(async (client) => {
      const old = await reversePaymentWithinTx(client, req.user.company_id, req.params.id);
      if (old) await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'delete', entity: 'payment', entityId: old.id, details: { type: old.type, amount: old.amount, date: old.date } });
      return old;
    });
    if (!removed) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
