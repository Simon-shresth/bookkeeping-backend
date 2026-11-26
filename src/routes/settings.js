const express = require('express');
const { z } = require('zod');
const { pool } = require('../db');
const { requireRole } = require('../auth');

const router = express.Router();

const settingsSchema = z.object({
  vatEnabled: z.boolean().optional(),
  vatRate: z.number().min(0).max(100).optional(),
});

// GET /api/settings - get all company settings
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select c.id, c.name, c.currency, c.fiscal_start, c.vat_enabled, c.vat_rate, c.vat_account_id,
              a.name as vat_account_name
       from companies c
       left join accounts a on a.id = c.vat_account_id
       where c.id = $1`,
      [req.user.company_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/settings - update company settings (VAT only for now)
router.put('/', requireRole('manager'), async (req, res, next) => {
  try {
    const body = settingsSchema.parse(req.body);
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (body.vatEnabled !== undefined) {
      updates.push(`vat_enabled = $${paramIndex++}`);
      values.push(body.vatEnabled);
    }
    if (body.vatRate !== undefined) {
      updates.push(`vat_rate = $${paramIndex++}`);
      values.push(body.vatRate);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No settings to update' });
    }

    values.push(req.user.company_id);

    const { rows } = await pool.query(
      `update companies set ${updates.join(', ')} where id = $${paramIndex} returning id, vat_enabled, vat_rate, vat_account_id`,
      values
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/settings/accounts - get VAT account options (liability accounts)
router.get('/accounts', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'select id, name, heading from accounts where company_id = $1 and category = $2 and is_system = true order by name',
      [req.user.company_id, 'Liabilities']
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;