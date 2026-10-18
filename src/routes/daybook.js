const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Helper: resolve the company's primary Cash account id (first system Cash account).
async function getCashAccountId(client, companyId) {
  const { rows } = await client.query(
    "select id from accounts where company_id=$1 and heading='Cash' and is_system=true order by created_at asc limit 1",
    [companyId]
  );
  return rows[0]?.id || null;
}

// Compute the net cash balance up to (but NOT including) a given date.
// Cash is a debit-normal (Assets) account: balance = sum(debit) - sum(credit).
async function getCashBalance(client, companyId, cashAccountId, beforeDate) {
  if (!cashAccountId) return 0;
  const { rows } = await client.query(
    `select
       coalesce(sum(jl.debit), 0)  as debit,
       coalesce(sum(jl.credit), 0) as credit
     from journal_lines jl
     join journal_entries je on je.id = jl.journal_entry_id
     where jl.account_id = $1
       and je.company_id = $2
       and je.date < $3`,
    [cashAccountId, companyId, beforeDate]
  );
  return Number(rows[0].debit) - Number(rows[0].credit);
}

// Compute the net movement on the Cash account ON a given date.
async function getCashMovementOnDate(client, companyId, cashAccountId, date) {
  if (!cashAccountId) return { debit: 0, credit: 0 };
  const { rows } = await client.query(
    `select
       coalesce(sum(jl.debit), 0)  as debit,
       coalesce(sum(jl.credit), 0) as credit
     from journal_lines jl
     join journal_entries je on je.id = jl.journal_entry_id
     where jl.account_id = $1
       and je.company_id = $2
       and je.date = $3`,
    [cashAccountId, companyId, date]
  );
  return { debit: Number(rows[0].debit), credit: Number(rows[0].credit) };
}

// GET /api/daybook?date=YYYY-MM-DD
// Returns all journal entries for the day with per-entry debit/credit totals,
// plus opening/closing cash balance and daily DR/CR aggregate totals.
router.get('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);

    const cashAccountId = await getCashAccountId(client, companyId);

    // Opening cash balance = everything before this date
    const openingCash = await getCashBalance(client, companyId, cashAccountId, date);

    // All journal entries for the day, with their lines joined for DR/CR totals and account details
    const { rows: entries } = await client.query(
      `select
         je.id,
         je.date::text as date,
         je.source,
         je.memo,
         je.reference,
         je.created_at,
         coalesce(sum(jl.debit), 0)  as total_debit,
         coalesce(sum(jl.credit), 0) as total_credit
       from journal_entries je
       left join journal_lines jl on jl.journal_entry_id = je.id
       where je.company_id = $1 and je.date = $2
       group by je.id, je.date, je.source, je.memo, je.reference, je.created_at
       order by je.created_at asc`,
      [companyId, date]
    );

    // Fetch full line detail for each entry (account names, debit/credit per line)
    const entryIds = entries.map((e) => e.id);
    let linesByEntry = {};
    if (entryIds.length) {
      const { rows: lines } = await client.query(
        `select jl.journal_entry_id, jl.account_id, a.name as account_name,
                a.heading, a.category, jl.debit, jl.credit
         from journal_lines jl
         join accounts a on a.id = jl.account_id
         where jl.journal_entry_id = any($1::uuid[])
         order by jl.id`,
        [entryIds]
      );
      for (const l of lines) {
        (linesByEntry[l.journal_entry_id] ||= []).push(l);
      }
    }

    // Build enriched entries with party resolution
    const enriched = await Promise.all(entries.map(async (e) => {
      const lines = linesByEntry[e.id] || [];

      // Resolve party name for display (customer or supplier linked to this entry's AR/AP line)
      let party = null;
      const arApLine = lines.find((l) => l.heading === 'Accounts Receivable' || l.heading === 'Accounts Payable');
      if (arApLine) {
        // account name IS the customer/supplier name (enforced by ensureSubAccount)
        party = arApLine.account_name;
      }

      // Determine transaction_type from source
      const type = {
        'Sale': 'SALE',
        'Purchase': 'PURCHASE',
        'Expense': 'EXPENSE',
        'Payment': e.memo?.toLowerCase().includes('received') ? 'RECEIPT' : 'PAYMENT',
        'Salary': 'EXPENSE',
        'Manual': 'JOURNAL',
        'Opening Balance': 'JOURNAL',
      }[e.source] || 'JOURNAL';

      return {
        id: e.id,
        date: e.date,
        transaction_type: type,
        source: e.source,
        ref_no: e.reference || null,
        party,
        narration: e.memo,
        debit: Number(e.total_debit),
        credit: Number(e.total_credit),
        lines,
      };
    }));

    // Cash movement on this date
    const cashMovement = await getCashMovementOnDate(client, companyId, cashAccountId, date);
    const closingCash = openingCash + cashMovement.debit - cashMovement.credit;

    // Daily totals across ALL entries (all accounts, not just cash)
    const totalDebit = enriched.reduce((s, e) => s + e.debit, 0);
    const totalCredit = enriched.reduce((s, e) => s + e.credit, 0);

    // Summary by type
    const byType = {};
    for (const e of enriched) {
      byType[e.transaction_type] = (byType[e.transaction_type] || 0) + 1;
    }

    res.json({
      date,
      entries: enriched,
      summary: {
        opening_cash: openingCash,
        closing_cash: closingCash,
        cash_received: cashMovement.debit,
        cash_paid: cashMovement.credit,
        total_debit: totalDebit,
        total_credit: totalCredit,
        transaction_count: enriched.length,
        by_type: byType,
      },
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
