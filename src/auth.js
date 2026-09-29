const jwt = require('jsonwebtoken');
const { pool } = require('./db');

function verifyToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
  } catch {
    return null;
  }
}

// Verifies the Supabase JWT only — does NOT require a `users` row to exist
// yet. Used exclusively by the onboarding route, since a brand-new sign-up
// has no company to belong to until that route creates one.
function requireSupabaseAuth(req, res, next) {
  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Missing or invalid bearer token' });
  req.authUserId = payload.sub;
  req.authEmail = payload.email;
  next();
}

// Verifies the Supabase-issued JWT sent from the frontend as
// `Authorization: Bearer <token>`, then loads this app's own user
// row (company_id, role) so every route knows who's asking and
// what company's data they're allowed to touch.
async function requireAuth(req, res, next) {
  try {
    const payload = verifyToken(req);
    if (!payload) return res.status(401).json({ error: 'Missing or invalid bearer token' });

    const authUserId = payload.sub;
    const { rows } = await pool.query(
      'select id, company_id, email, role, is_active from users where id = $1',
      [authUserId]
    );
    const user = rows[0];
    if (!user) return res.status(403).json({ error: 'No profile found for this account. Ask an admin to add you to a company.' });
    if (!user.is_active) return res.status(403).json({ error: 'This account has been deactivated.' });

    req.user = user; // { id, company_id, email, role }
    next();
  } catch (err) {
    next(err);
  }
}

// Role hierarchy: admin > accountant > manager > viewer.
// requireRole('accountant') allows accountant and admin, blocks manager/viewer.
const ROLE_RANK = { viewer: 0, manager: 1, accountant: 2, admin: 3 };

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (ROLE_RANK[req.user.role] < ROLE_RANK[minRole]) {
      return res.status(403).json({ error: `Requires ${minRole} role or higher` });
    }
    next();
  };
}

module.exports = { requireAuth, requireSupabaseAuth, requireRole, ROLE_RANK };
