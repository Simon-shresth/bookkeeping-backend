const express = require('express');
const { z } = require('zod');
const { pool } = require('../db');
const { requireRole } = require('../auth');
const { supabaseAdmin } = require('../lib/supabaseAdmin');
const { audit } = require('../services/audit');

const router = express.Router();

const ROLES = ['viewer', 'manager', 'accountant', 'admin'];

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'select id, email, full_name, role, is_active, created_at from users where company_id=$1 order by created_at',
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const inviteSchema = z.object({ email: z.string().email(), role: z.enum(ROLES) });

// POST /api/users/invite — creates (or attaches) a Supabase auth account for
// this email and sends them an invite email (via Supabase) to set a
// password. Their `users` row is created immediately with the chosen role,
// so access is ready the moment they finish signing in.
router.post('/invite', requireRole('admin'), async (req, res, next) => {
  try {
    const { email, role } = inviteSchema.parse(req.body);

    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${process.env.FRONTEND_URL || process.env.CORS_ORIGIN}/reset-password`,
    });
    if (error) {
      // "already been registered" is the common case — that auth user
      // already exists, so look them up instead of failing outright.
      const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers();
      const existingAuthUser = !listErr && list.users.find((u) => u.email === email);
      if (!existingAuthUser) return res.status(400).json({ error: error.message });

      await pool.query(
        `insert into users (id, company_id, email, role) values ($1,$2,$3,$4)
         on conflict (id) do update set company_id = excluded.company_id, role = excluded.role, is_active = true`,
        [existingAuthUser.id, req.user.company_id, email, role]
      );
      await audit(pool, { companyId: req.user.company_id, userId: req.user.id, action: 'create', entity: 'user', entityId: existingAuthUser.id, details: { email, role } });
      return res.status(200).json({ id: existingAuthUser.id, email, role, note: 'This email already had an account — added them to your company directly.' });
    }

    await pool.query(
      `insert into users (id, company_id, email, role) values ($1,$2,$3,$4)`,
      [data.user.id, req.user.company_id, email, role]
    );
    await audit(pool, { companyId: req.user.company_id, userId: req.user.id, action: 'create', entity: 'user', entityId: data.user.id, details: { email, role } });
    res.status(201).json({ id: data.user.id, email, role });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This person is already part of a company.' });
    next(err);
  }
});

const patchSchema = z.object({ role: z.enum(ROLES).optional(), isActive: z.boolean().optional() });

router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { role, isActive } = patchSchema.parse(req.body);
    if (req.params.id === req.user.id && isActive === false) {
      return res.status(400).json({ error: "You can't deactivate your own account." });
    }
    if (req.params.id === req.user.id && role && role !== 'admin') {
      return res.status(400).json({ error: "You can't change your own role away from admin." });
    }
    const { rows } = await pool.query(
      `update users set role = coalesce($1, role), is_active = coalesce($2, is_active)
       where id = $3 and company_id = $4 returning id, email, full_name, role, is_active`,
      [role ?? null, isActive ?? null, req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    await audit(pool, { companyId: req.user.company_id, userId: req.user.id, action: 'update', entity: 'user', entityId: rows[0].id, details: { email: rows[0].email, role: rows[0].role, isActive: rows[0].is_active } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
