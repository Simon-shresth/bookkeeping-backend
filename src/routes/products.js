const express = require('express');
const { z } = require('zod');
const { pool } = require('../db');
const { requireRole } = require('../auth');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from products where company_id=$1 order by name', [req.user.company_id]);
    res.json(rows);
  } catch (err) { next(err); }
});

const schema = z.object({
  name: z.string().min(1),
  purchasePrice: z.number().min(0),
  sellPrice: z.number().min(0),
  stock: z.number().default(0),
  minStock: z.number().min(0).default(0),
});

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const b = schema.parse(req.body);
    const { rows } = await pool.query(
      `insert into products (company_id, name, purchase_price, sell_price, stock, min_stock)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [req.user.company_id, b.name, b.purchasePrice, b.sellPrice, b.stock, b.minStock]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A product with this name already exists.' });
    next(err);
  }
});

router.put('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const b = schema.parse(req.body);
    const { rows } = await pool.query(
      `update products set name=$1, purchase_price=$2, sell_price=$3, stock=$4, min_stock=$5
       where id=$6 and company_id=$7 returning *`,
      [b.name, b.purchasePrice, b.sellPrice, b.stock, b.minStock, req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A product with this name already exists.' });
    next(err);
  }
});

router.delete('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const result = await pool.query('delete from products where id=$1 and company_id=$2', [req.params.id, req.user.company_id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'This product has sales or purchases on record and cannot be deleted.' });
    next(err);
  }
});

module.exports = router;
