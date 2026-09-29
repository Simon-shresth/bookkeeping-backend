const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../auth');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/audit?entity=sales_invoice&limit=100&before=<ISO timestamp>
// Newest first. Pass the last row's created_at as `before` to page back.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const params = [req.user.company_id];
    let where = 'where a.company_id = $1';
    if (req.query.entity) { params.push(req.query.entity); where += ` and a.entity = $${params.length}`; }
    // Keyset cursor "<microsecond-precision UTC timestamp>|<id>" — a JS Date
    // only holds milliseconds, so paging on Date values could skip rows.
    if (req.query.before) {
      const [ts, id] = String(req.query.before).split('|');
      if (!ts || !UUID.test(id || '')) return res.status(400).json({ error: 'Invalid cursor' });
      params.push(ts, id);
      where += ` and (a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `select a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, u.email as user_email,
              to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts
       from audit_logs a left join users u on u.id = a.user_id
       ${where}
       order by a.created_at desc, a.id desc
       limit $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
