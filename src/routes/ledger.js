const express = require('express');
const { pool } = require('../db');
const { getAccountLedger } = require('../services/ledger');
const { buildLedgerPdf } = require('../services/ledgerPdf');

const router = express.Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function parseRange(req) {
  const from = DATE.test(req.query.from || '') ? req.query.from : undefined;
  const till = DATE.test(req.query.till || '') ? req.query.till : undefined;
  return { from, till };
}

// GET /api/ledger/:accountId?from=YYYY-MM-DD&till=YYYY-MM-DD
// Both dates are optional; omitting both returns the full history (as before).
router.get('/:accountId', async (req, res, next) => {
  try {
    const ledger = await getAccountLedger(req.user.company_id, req.params.accountId, parseRange(req));
    if (!ledger) return res.status(404).json({ error: 'Account not found' });
    res.json(ledger);
  } catch (err) { next(err); }
});

// GET /api/ledger/:accountId/pdf?from=&till=
router.get('/:accountId/pdf', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    const { from, till } = parseRange(req);
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
