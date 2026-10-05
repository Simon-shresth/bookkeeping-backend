const express = require('express');
const { z } = require('zod');
const { pool } = require('../db');
const { requireRole } = require('../auth');

const router = express.Router();

// GET /api/employees
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'select * from employees where company_id=$1 order by name',
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const employeeSchema = z.object({
  name: z.string().min(1),
  position: z.string().optional(),
  salary: z.number().min(0),
});

// POST /api/employees
router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const body = employeeSchema.parse(req.body);
    const { rows } = await pool.query(
      'insert into employees (company_id, name, position, salary) values ($1,$2,$3,$4) returning *',
      [req.user.company_id, body.name, body.position || null, body.salary]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An employee with this name already exists.' });
    next(err);
  }
});

// PATCH /api/employees/:id
router.patch('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const body = employeeSchema.parse(req.body);
    const { rows } = await pool.query(
      `update employees set name=$1, position=$2, salary=$3
       where id=$4 and company_id=$5 returning *`,
      [body.name, body.position || null, body.salary, req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An employee with this name already exists.' });
    next(err);
  }
});

// PATCH /api/employees/:id/deactivate — soft delete
router.patch('/:id/deactivate', requireRole('manager'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'update employees set is_active=$1 where id=$2 and company_id=$3 returning *',
      [req.body.is_active ?? false, req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
