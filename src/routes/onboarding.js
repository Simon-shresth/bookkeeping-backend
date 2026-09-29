const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');

const router = express.Router();

const schema = z.object({ companyName: z.string().min(1) });

// POST /api/onboarding/company
// Called right after a brand-new Supabase sign-up. Creates the company,
// seeds its Chart of Accounts, and makes the calling (already-authenticated)
// Supabase user its first admin. Requires only requireSupabaseAuth (see
// server.js) — not requireAuth — since there's no company to check yet.
router.post('/company', async (req, res, next) => {
  try {
    const { companyName } = schema.parse(req.body);

    const existing = await pool.query('select id from users where id = $1', [req.authUserId]);
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'This account is already linked to a company.' });
    }

    const companyId = await withTransaction(async (client) => {
      const companyRes = await client.query('insert into companies (name) values ($1) returning id', [companyName]);
      const id = companyRes.rows[0].id;
      await client.query('select seed_default_accounts($1)', [id]);
      await client.query(
        `insert into users (id, company_id, email, role) values ($1,$2,$3,'admin')`,
        [req.authUserId, id, req.authEmail]
      );
      return id;
    });

    res.status(201).json({ companyId });
  } catch (err) { next(err); }
});

module.exports = router;
