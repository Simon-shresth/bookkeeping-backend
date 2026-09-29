const express = require('express');
const { getAccountLedger } = require('../services/ledger');

const router = express.Router();

// GET /api/ledger/:accountId — full chronological ledger for one account
router.get('/:accountId', async (req, res, next) => {
  try {
    const ledger = await getAccountLedger(req.user.company_id, req.params.accountId);
    if (!ledger) return res.status(404).json({ error: 'Account not found' });
    res.json(ledger);
  } catch (err) { next(err); }
});

module.exports = router;
