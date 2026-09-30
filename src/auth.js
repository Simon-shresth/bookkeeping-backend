const crypto = require('crypto');

// `pool` (Postgres) is only needed by requireAuth, which looks up the
// company/role row. Requiring it lazily, inside that function, keeps the
// token-verification code (verifyJwt) independently testable with zero
// dependencies beyond Node's built-in crypto module.
function db() { return require('./db').pool; }

// Supabase signs sign-in tokens one of two ways, and which one a project
// uses depends on when it was created / whether it's been migrated:
//   - Legacy: a single shared secret (HS256) — SUPABASE_JWT_SECRET.
//   - Current default: a public/private key pair (ES256 or RS256), verified
//     against Supabase's published public keys (JWKS), no secret needed.
// Every token says which one it used in its header ("alg"), so we check
// that and verify accordingly — no configuration needed either way, and
// no dependency beyond Node's built-in crypto module.

let jwksCache = { keys: [], fetchedAt: 0 };
const JWKS_TTL_MS = 10 * 60 * 1000;

async function fetchJwks() {
  if (!process.env.SUPABASE_URL) return [];
  const now = Date.now();
  if (jwksCache.keys.length && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`Failed to fetch Supabase JWKS (${res.status})`);
  const body = await res.json();
  jwksCache = { keys: body.keys || [], fetchedAt: now };
  return jwksCache.keys;
}

function b64urlToBuffer(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJsonPart(part) {
  return JSON.parse(b64urlToBuffer(part).toString('utf8'));
}

// The verification core, isolated from Express so it can be exercised
// directly (see auth.test.js). `getJwks` is injectable for that reason.
async function verifyJwt(token, { getJwks = fetchJwks } = {}) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = decodeJsonPart(headerB64);
    payload = decodeJsonPart(payloadB64);
  } catch {
    return null;
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = b64urlToBuffer(sigB64);

  try {
    if (header.alg === 'HS256') {
      if (!process.env.SUPABASE_JWT_SECRET) return null;
      const expected = crypto.createHmac('sha256', process.env.SUPABASE_JWT_SECRET).update(signingInput).digest();
      if (expected.length !== signature.length || !crypto.timingSafeEqual(expected, signature)) return null;
    } else if (header.alg === 'ES256' || header.alg === 'RS256') {
      const keys = await getJwks();
      const jwk = header.kid ? keys.find((k) => k.kid === header.kid) : keys.find((k) => k.alg === header.alg);
      if (!jwk) return null;
      const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const ok = header.alg === 'ES256'
        ? crypto.verify('sha256', signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
        : crypto.verify('sha256', signingInput, publicKey, signature);
      if (!ok) return null;
    } else {
      return null; // unsupported/unexpected algorithm
    }
  } catch {
    return null;
  }

  if (typeof payload.exp === 'number' && Date.now() >= payload.exp * 1000) return null; // expired
  return payload;
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// Verifies the Supabase JWT only — does NOT require a `users` row to exist
// yet. Used exclusively by the onboarding route, since a brand-new sign-up
// has no company to belong to until that route creates one.
async function requireSupabaseAuth(req, res, next) {
  const token = bearerToken(req);
  const payload = token ? await verifyJwt(token) : null;
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
    const token = bearerToken(req);
    const payload = token ? await verifyJwt(token) : null;
    if (!payload) return res.status(401).json({ error: 'Missing or invalid bearer token' });

    const { rows } = await db().query(
      'select id, company_id, email, role, is_active from users where id = $1',
      [payload.sub]
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

module.exports = { requireAuth, requireSupabaseAuth, requireRole, ROLE_RANK, verifyJwt };
