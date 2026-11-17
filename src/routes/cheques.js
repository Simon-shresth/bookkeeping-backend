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
       order by c.cheque_date asc`,
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
  cashedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
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

router.delete('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('delete from cheques where id=$1 and company_id=$2 returning id', [req.params.id, req.user.company_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await audit(pool, { companyId: req.user.company_id, userId: req.user.id, action: 'delete', entity: 'cheque', entityId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
