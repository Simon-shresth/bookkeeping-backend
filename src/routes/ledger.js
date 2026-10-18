const express = require('express');
const { pool } = require('../db');
const { getAccountLedger, getCurrentFiscalYear } = require('../services/ledger');
const { buildLedgerPdf } = require('../services/ledgerPdf');

const router = express.Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function parseRange(req) {
  const from = DATE.test(req.query.from || '') ? req.query.from : undefined;
  const till = DATE.test(req.query.till || '') ? req.query.till : undefined;
  return { from, till };
}

// GET /api/ledger/:accountId?from=YYYY-MM-DD&till=YYYY-MM-DD&allYears=true
// By default, limits to the current fiscal year: opening balance = sum of all
// journal lines before the fiscal year start; only current-year entries are
// shown. Pass allYears=true (or an explicit from) to see prior-year history.
router.get('/:accountId', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    let { from, till } = parseRange(req);
    const allYears = req.query.allYears === 'true';

    // If no explicit from and not allYears, default to current fiscal year start
    if (!from && !allYears) {
      const fy = await getCurrentFiscalYear(companyId);
      if (fy) from = fy.start_date;
    }

    const ledger = await getAccountLedger(companyId, req.params.accountId, { from, till });
    if (!ledger) return res.status(404).json({ error: 'Account not found' });
    res.json({ ...ledger, from, till });
  } catch (err) { next(err); }
});

// GET /api/ledger/:accountId/pdf?from=&till=&allYears=true
router.get('/:accountId/pdf', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    let { from, till } = parseRange(req);
    const allYears = req.query.allYears === 'true';

    if (!from && !allYears) {
      const fy = await getCurrentFiscalYear(companyId);
      if (fy) from = fy.start_date;
    }

    const ledger = await getAccountLedger(companyId, req.params.accountId, { from, till });
    if (!ledger) return res.status(404).json({ error: 'Account not found' });

    const { rows } = await pool.query('select name, currency from companies where id=$1', [companyId]);
    const company = rows[0];

    const pdf = await buildLedgerPdf({
      company,
      account: ledger.account,
      openingBalance: ledger.openingBalance,
      closingBalance: ledger.closingBalance,
      entries: ledger.entries,
      from, till,
    });

    const safeName = ledger.account.name.replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ledger-${safeName}.pdf"`);
    res.send(pdf);
  } catch (err) { next(err); }
});

module.exports = router;
