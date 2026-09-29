const express = require('express');
const { z } = require('zod');
const { pool } = require('../db');
const { requireRole } = require('../auth');
const { getChartOfAccounts, DEFAULT_HEADINGS } = require('../services/ledger');

const router = express.Router();

// GET /api/accounts — full Chart of Accounts with live balances (read-only view)
router.get('/', async (req, res, next) => {
  try {
    res.json(await getChartOfAccounts(req.user.company_id));
  } catch (err) { next(err); }
});

// GET /api/accounts/options — flat list, grouped by heading, for populating
// dropdowns (e.g. in the Journal Entry form).
router.get('/options', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'select id, name, heading, category from accounts where company_id=$1 order by category, heading, name',
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const createSchema = z.object({
  name: z.string().min(1),
  heading: z.string().min(1),
});

// POST /api/accounts — create a new sub-account under an existing heading
// (e.g. a second bank account). Accounts Receivable / Accounts Payable are
// blocked here since those are managed only via Customers/Suppliers.
router.post('/', requireRole('accountant'), async (req, res, next) => {
  try {
    const { name, heading } = createSchema.parse(req.body);
    if (heading === 'Accounts Receivable' || heading === 'Accounts Payable') {
      return res.status(400).json({ error: 'Accounts Receivable and Accounts Payable accounts are created automatically from Customers and Suppliers.' });
    }
    const category = Object.entries(DEFAULT_HEADINGS).find(([, heads]) => heads.includes(heading))?.[0];
    if (!category) return res.status(400).json({ error: `Unknown heading: ${heading}` });

    const { rows } = await pool.query(
      'insert into accounts (company_id, name, heading, category) values ($1,$2,$3,$4) returning *',
      [req.user.company_id, name, heading, category]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this name already exists.' });
    next(err);
  }
});

module.exports = router;
