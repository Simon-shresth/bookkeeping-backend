const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');

const router = express.Router();

const schema = z.object({
  companyName: z.string().min(1),
  fiscalStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// POST /api/onboarding/company
// Called right after a brand-new Supabase sign-up. Creates the company,
// seeds its Chart of Accounts, makes the calling (already-authenticated)
// Supabase user its first admin, and opens the company's first fiscal year.
// Requires only requireSupabaseAuth (see server.js) — not requireAuth —
// since there's no company to check yet.
router.post('/company', async (req, res, next) => {
  try {
    const { companyName, fiscalStart } = schema.parse(req.body);

    const existing = await pool.query('select id from users where id = $1', [req.authUserId]);
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'This account is already linked to a company.' });
    }

    const companyId = await withTransaction(async (client) => {
      const companyRes = await client.query('insert into companies (name, fiscal_start) values ($1, $2) returning id', [companyName, fiscalStart || null]);
      const id = companyRes.rows[0].id;
      await client.query('select seed_default_accounts($1)', [id]);
      await client.query(
        `insert into users (id, company_id, email, role) values ($1,$2,$3,'admin')`,
        [req.authUserId, id, req.authEmail]
      );

      // Open the company's first fiscal year
      const startDate = fiscalStart || new Date().toISOString().slice(0, 10);
      await client.query(
        `insert into fiscal_years (company_id, start_date, end_date, status)
         values ($1, $2, ($2::date + interval '1 year' - interval '1 day')::date, 'open')`,
        [id, startDate]
      );
      return id;
    });

    res.status(201).json({ companyId });
  } catch (err) { next(err); }
});

module.exports = router;
