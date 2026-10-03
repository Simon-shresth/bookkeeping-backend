const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { createPaymentWithinTx, reversePaymentWithinTx } = require('../services/payments');
const { companyToday } = require('../services/dates');
const { audit } = require('../services/audit');

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
      `select p.*, c.name as customer_name, s.name as supplier_name, a.name as account_name,
              si.invoice_number as sales_invoice_number, pi.invoice_number as purchase_invoice_number
       from payments p
       left join customers c on c.id = p.customer_id
       left join suppliers s on s.id = p.supplier_id
       left join sales_invoices si on si.id = p.sales_invoice_id
       left join purchase_invoices pi on pi.id = p.purchase_invoice_id
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
  accountId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reference: z.string().optional(),
});

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const body = schema.parse(req.body);
    const payment = await withTransaction(async (client) => {
      const date = body.date || await companyToday(client, req.user.company_id);
      const p = await createPaymentWithinTx(client, req.user.company_id, req.user.id, { ...body, date });
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
      const date = body.date || await companyToday(client, req.user.company_id);
      const p = await createPaymentWithinTx(client, req.user.company_id, req.user.id, { ...body, date });
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
