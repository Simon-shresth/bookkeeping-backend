const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { postJournal, reverseJournalEntry } = require('../services/ledger');
const { audit } = require('../services/audit');

const router = express.Router();

// GET /api/opening-balances — list all opening balances for the company
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select ob.*, a.name as account_name, a.heading, a.category
       from opening_balances ob
       join accounts a on a.id = ob.account_id
       where ob.company_id = $1
       order by a.category, a.heading, a.name`,
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const schema = z.object({
  accountId: z.string().uuid(),
  amount: z.number(),   // positive = normal balance side; negative = opposite side
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// POST /api/opening-balances — set or update an opening balance for one account.
// We use an upsert so the user can correct a balance they entered wrong.
router.post('/', requireRole('accountant'), async (req, res, next) => {
  try {
    const { accountId, amount, date } = schema.parse(req.body);
    const companyId = req.user.company_id;

    const result = await withTransaction(async (client) => {
      // Verify account belongs to company
      const { rows: accs } = await client.query(
        'select id, name, category from accounts where id=$1 and company_id=$2',
        [accountId, companyId]
      );
      if (!accs[0]) { const e = new Error('Account not found'); e.status = 404; throw e; }
      const account = accs[0];

      // Find the "Opening Balances Equity" clearing account.
      // We use Retained Earnings as the balancing account — the standard for
      // entering opening balances into a double-entry system.
      const { rows: eq } = await client.query(
        "select id from accounts where company_id=$1 and heading='Retained Earnings' and is_system=true limit 1",
        [companyId]
      );
      if (!eq[0]) { const e = new Error('Retained Earnings account not found — run company setup first.'); e.status = 400; throw e; }
      const equityId = eq[0].id;

      // Reverse any previous opening balance journal for this account
      const { rows: existing } = await client.query(
        'select * from opening_balances where company_id=$1 and account_id=$2',
        [companyId, accountId]
      );
      if (existing[0]?.journal_entry_id) {
        await reverseJournalEntry(client, existing[0].journal_entry_id);
      }

      // If amount is zero, just delete the record and we're done
      if (Math.abs(amount) < 0.005) {
        await client.query(
          'delete from opening_balances where company_id=$1 and account_id=$2',
          [companyId, accountId]
        );
        return null;
      }

      // Build journal lines: debit-normal accounts get debit on positive amount
      const { isDebitNormal } = require('../services/ledger');
      const debitNormal = isDebitNormal(account.category);
      const absAmount = Math.abs(amount);
      const isPositive = amount > 0;

      // Positive amount = normal balance increase:
      //   debit-normal account (Asset/Expense): debit the account, credit Retained Earnings
      //   credit-normal account (Liability/Equity/Income): credit the account, debit Retained Earnings
      let lines;
      if (debitNormal) {
        if (isPositive) {
          lines = [
            { accountId, debit: absAmount, credit: 0 },
            { accountId: equityId, debit: 0, credit: absAmount },
          ];
        } else {
          lines = [
            { accountId: equityId, debit: absAmount, credit: 0 },
            { accountId, debit: 0, credit: absAmount },
          ];
        }
      } else {
        if (isPositive) {
          lines = [
            { accountId: equityId, debit: absAmount, credit: 0 },
            { accountId, debit: 0, credit: absAmount },
          ];
        } else {
          lines = [
            { accountId, debit: absAmount, credit: 0 },
            { accountId: equityId, debit: 0, credit: absAmount },
          ];
        }
      }

      const entry = await postJournal(client, {
        companyId,
        date,
        memo: `Opening balance — ${account.name}`,
        source: 'Opening Balance',
        lines,
        createdBy: req.user.id,
      });

      // Upsert the opening_balances record
      const { rows: ob } = await client.query(
        `insert into opening_balances (company_id, account_id, amount, date, journal_entry_id, created_by)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (company_id, account_id)
         do update set amount=$3, date=$4, journal_entry_id=$5, created_by=$6
         returning *`,
        [companyId, accountId, amount, date, entry?.id || null, req.user.id]
      );

      await audit(client, {
        companyId, userId: req.user.id, action: existing[0] ? 'update' : 'create',
        entity: 'opening_balance', entityId: ob[0].id,
        details: { accountId, accountName: account.name, amount, date },
      });

      return ob[0];
    });

    if (!result) return res.status(204).end();
    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/opening-balances/:accountId — remove opening balance for one account
router.delete('/:accountId', requireRole('accountant'), async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        'select * from opening_balances where company_id=$1 and account_id=$2',
        [companyId, req.params.accountId]
      );
      if (!rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
      if (rows[0].journal_entry_id) {
        await reverseJournalEntry(client, rows[0].journal_entry_id);
      }
      await client.query(
        'delete from opening_balances where company_id=$1 and account_id=$2',
        [companyId, req.params.accountId]
      );
      await audit(client, {
        companyId, userId: req.user.id, action: 'delete',
        entity: 'opening_balance', entityId: rows[0].id,
        details: { accountId: req.params.accountId },
      });
    });
    res.status(204).end();
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
