const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { audit } = require('../services/audit');
const { companyToday } = require('../services/dates');

const router = express.Router();

// GET /api/cheques?customerId=
router.get('/', async (req, res, next) => {
  try {
    const params = [req.user.company_id];
    let where = 'where c.company_id = $1';
    if (req.query.customerId) {
      params.push(req.query.customerId);
      where += ' and c.customer_id = $2';
    }
    const { rows } = await pool.query(
      `select c.*, cust.name as customer_name
       from cheques c
       join customers cust on cust.id = c.customer_id
       ${where}
       order by c.cheque_date asc, c.created_at asc`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const schema = z.object({
  chequeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  customerId: z.string().uuid(),
  bankName: z.string().trim().min(1),
  chequeNumber: z.string().trim().min(1),
  amount: z.number().positive(),
  draweeName: z.string().trim().min(1),
  chequeOwner: z.string().trim().min(1),
  isCashed: z.boolean().default(false),
  cashedAmount: z.number().nonnegative().default(0),
  cashedDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal(''), z.null()]).optional().transform((v) => v || null),
}).transform((data) => {
  let isCashed = data.isCashed;
  let cashedAmount = data.cashedAmount;
  if (isCashed && cashedAmount === 0) {
    cashedAmount = data.amount;
  } else if (cashedAmount >= data.amount) {
    isCashed = true;
    cashedAmount = data.amount;
  }
  return { ...data, isCashed, cashedAmount };
});

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const body = schema.parse(req.body);
    const { rows } = await pool.query(
      `insert into cheques (company_id, cheque_date, customer_id, bank_name, cheque_number, amount, drawee_name, cheque_owner, is_cashed, cashed_amount, cashed_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [req.user.company_id, body.chequeDate, body.customerId, body.bankName, body.chequeNumber, body.amount, body.draweeName, body.chequeOwner, body.isCashed, body.cashedAmount, body.cashedDate]
    );
    await audit(pool, { companyId: req.user.company_id, userId: req.user.id, action: 'create', entity: 'cheque', entityId: rows[0].id, details: body });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const body = schema.parse(req.body);
    const { rows } = await pool.query(
      `update cheques set cheque_date=$1, customer_id=$2, bank_name=$3, cheque_number=$4, amount=$5, drawee_name=$6, cheque_owner=$7, is_cashed=$8, cashed_amount=$9, cashed_date=$10
       where id=$11 and company_id=$12 returning *`,
      [body.chequeDate, body.customerId, body.bankName, body.chequeNumber, body.amount, body.draweeName, body.chequeOwner, body.isCashed, body.cashedAmount, body.cashedDate, req.params.id, req.user.company_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await audit(pool, { companyId: req.user.company_id, userId: req.user.id, action: 'update', entity: 'cheque', entityId: rows[0].id, details: body });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

const cashSchema = z.object({
  isCashed: z.boolean().optional(),
  cashedAmount: z.number().nonnegative(),
  cashedDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal(''), z.null()]).optional().transform((v) => v || null),
});

// POST /api/cheques/:id/cash — record a cash event (full or partial payment).
// Updates the cheque's running cumulative state AND appends a row to
// cheque_cashings so the Cheques screen can show previous partial cash
// receipts while recording the next payment.
router.post('/:id/cash', requireRole('manager'), async (req, res, next) => {
  try {
    const body = cashSchema.parse(req.body);
    const cashDate = body.cashedDate || await companyToday(pool, req.user.company_id);
    const cheque = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(
        'select * from cheques where id = $1 and company_id = $2',
        [req.params.id, req.user.company_id]
      );
      if (existing.length === 0) { const e = new Error('Not found'); e.status = 404; throw e; }
      const ch = existing[0];
      const totalAmount = Number(ch.amount);
      let cashedAmount = body.cashedAmount;
      let isCashed = body.isCashed ?? (cashedAmount >= totalAmount);
      if (isCashed && cashedAmount === 0) cashedAmount = totalAmount;
      else if (cashedAmount >= totalAmount) { isCashed = true; cashedAmount = totalAmount; }

      const { rows } = await client.query(
        `update cheques set is_cashed = $1, cashed_amount = $2, cashed_date = $3
         where id = $4 and company_id = $5 returning *`,
        [isCashed, cashedAmount, cashDate, req.params.id, req.user.company_id]
      );
      const updated = rows[0];

      const { rows: cashRows } = await client.query(
        `insert into cheque_cashings (company_id, cheque_id, cash_date, amount, is_full)
         values ($1,$2,$3,$4,$5) returning *`,
        [req.user.company_id, req.params.id, cashDate, cashedAmount, isCashed]
      );

      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'cash_cheque', entity: 'cheque', entityId: req.params.id, details: { cashedAmount, cashDate, isCashed } });

      return { cheque: updated, cashing: cashRows[0] };
    });
    res.json(cheque);
  } catch (err) { next(err); }
});

// GET /api/cheques/:id/cashings — prior cash events (full / partial payments)
// recorded against this cheque, oldest first.
router.get('/:id/cashings', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select cc.id, cc.cheque_id, cc.cash_date::text as cash_date, cc.amount, cc.is_full, cc.created_at
       from cheque_cashings cc
       where cc.cheque_id = $1 and cc.company_id = $2
       order by cc.cash_date asc, cc.created_at asc`,
      [req.params.id, req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('delete from cheques where id=$1 and company_id=$2 returning id', [req.params.id, req.user.company_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await audit(pool, { companyId: req.user.company_id, userId: req.user.id, action: 'delete', entity: 'cheque', entityId: rows[0].id, details: {} });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
