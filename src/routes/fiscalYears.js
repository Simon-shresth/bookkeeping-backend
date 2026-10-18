const express = require('express');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { isDebitNormal } = require('../services/ledger');
const { audit } = require('../services/audit');

const router = express.Router();

// GET /api/fiscal-years — list all fiscal years for the company
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select fy.*, u.email as closed_by_email
       from fiscal_years fy
       left join users u on u.id = fy.closed_by
       where fy.company_id = $1
       order by fy.start_date desc`,
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/fiscal-years/current — the current open fiscal year (or null)
router.get('/current', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select * from fiscal_years
       where company_id = $1 and status = 'open'
       order by start_date desc limit 1`,
      [req.user.company_id]
    );
    res.json(rows[0] || null);
  } catch (err) { next(err); }
});

// GET /api/fiscal-years/:id/opening-balances — per-account balances as of the
// fiscal year's start date. Reuses the same sum-before-date pattern as
// getAccountLedger's opening balance (ledger.js:122-130).
router.get('/:id/opening-balances', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    const { rows: fyRows } = await pool.query(
      'select * from fiscal_years where id=$1 and company_id=$2',
      [req.params.id, companyId]
    );
    if (!fyRows[0]) return res.status(404).json({ error: 'Fiscal year not found' });
    const fy = fyRows[0];

    const { rows } = await pool.query(
      `select a.id, a.name, a.heading, a.category,
              coalesce(sum(jl.debit), 0)  as debit,
              coalesce(sum(jl.credit), 0) as credit
       from accounts a
       left join journal_lines jl on jl.account_id = a.id
       left join journal_entries je on je.id = jl.journal_entry_id
            and je.company_id = a.company_id and je.date < $2
       where a.company_id = $1
       group by a.id, a.name, a.heading, a.category
       order by a.category, a.heading, a.name`,
      [companyId, fy.start_date]
    );

    const balances = rows.map((r) => {
      const bal = isDebitNormal(r.category)
        ? Number(r.debit) - Number(r.credit)
        : Number(r.credit) - Number(r.debit);
      return { id: r.id, name: r.name, heading: r.heading, category: r.category, balance: bal };
    });

    res.json({ fiscal_year: fy, balances });
  } catch (err) { next(err); }
});

// POST /api/fiscal-years/close — close the current open year and open the next.
// Soft close: no closing journal entry; rollover is computed at report time.
router.post('/close', requireRole('admin'), async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    const result = await withTransaction(async (client) => {
      const { rows: openRows } = await client.query(
        "select * from fiscal_years where company_id=$1 and status='open' order by start_date desc limit 1",
        [companyId]
      );
      if (!openRows[0]) { const e = new Error('No open fiscal year to close'); e.status = 404; throw e; }
      const oldYear = openRows[0];

      // Next year: starts the day after the old year ends, ends one year later minus a day
      const nextStart = new Date(oldYear.end_date);
      nextStart.setDate(nextStart.getDate() + 1);
      const nextEnd = new Date(nextStart);
      nextEnd.setFullYear(nextEnd.getFullYear() + 1);
      nextEnd.setDate(nextEnd.getDate() - 1);
      const fmt = (d) => d.toISOString().slice(0, 10);

      const { rows: nextRows } = await client.query(
        `insert into fiscal_years (company_id, start_date, end_date, status)
         values ($1, $2, $3, 'open')
         on conflict (company_id, start_date) do update set status='open'
         returning *`,
        [companyId, fmt(nextStart), fmt(nextEnd)]
      );
      const nextYear = nextRows[0];

      const { rows: closedRows } = await client.query(
        `update fiscal_years set status='closed', closed_by=$2, closed_at=now()
         where id=$1 returning *`,
        [oldYear.id, req.user.id]
      );

      await audit(client, {
        companyId, userId: req.user.id, action: 'create',
        entity: 'fiscal_year_close', entityId: oldYear.id,
        details: { closedYearId: oldYear.id, closedYearEnd: oldYear.end_date, nextYearId: nextYear.id, nextYearStart: nextYear.start_date },
      });

      return { closed: closedRows[0], next: nextYear };
    });

    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
