const { pool } = require('../db');

const DEBIT_NORMAL = new Set(['Assets', 'Expenses']);
function isDebitNormal(category) {
  return DEBIT_NORMAL.has(category);
}

// Finds an account by name for this company, creating it under the
// given heading/category if it doesn't exist yet. This is how a new
// customer or supplier automatically gets their own AR/AP ledger
// account the first time they're used in a transaction.
async function ensureSubAccount(client, companyId, name, heading, category) {
  const existing = await client.query(
    'select id from accounts where company_id = $1 and name = $2',
    [companyId, name]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await client.query(
    `insert into accounts (company_id, name, heading, category, is_system)
     values ($1, $2, $3, $4, false) returning id`,
    [companyId, name, heading, category]
  );
  return inserted.rows[0].id;
}

// Posts one balanced journal entry (a set of lines whose debits equal
// credits). Lines with a zero amount are dropped. Returns null if
// nothing meaningful was posted (e.g. a fully-paid-on-both-sides
// no-op), otherwise the new journal_entries row.
async function postJournal(client, { companyId, date, memo, remark, source, reference, lines, createdBy }) {
  const clean = lines.filter((l) => Number(l.debit || 0) > 0.004 || Number(l.credit || 0) > 0.004);
  if (!clean.length) return null;

  const totalDebit = clean.reduce((s, l) => s + Number(l.debit || 0), 0);
  const totalCredit = clean.reduce((s, l) => s + Number(l.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    const err = new Error(`Journal entry does not balance: debits ${totalDebit} vs credits ${totalCredit}`);
    err.status = 400;
    throw err;
  }

  const entryRes = await client.query(
    `insert into journal_entries (company_id, date, memo, remark, source, reference, created_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [companyId, date, memo, remark || null, source, reference || null, createdBy || null]
  );
  const entry = entryRes.rows[0];

  for (const line of clean) {
    await client.query(
      `insert into journal_lines (journal_entry_id, account_id, debit, credit)
       values ($1,$2,$3,$4)`,
      [entry.id, line.accountId, line.debit || 0, line.credit || 0]
    );
  }
  return entry;
}

// Deletes a journal entry and its lines (lines cascade via FK).
// Used when reversing a sale/purchase/expense on edit or delete.
// Refuses if any line has already been cleared in a bank reconciliation —
// silently removing it would make a signed-off reconciliation wrong.
async function reverseJournalEntry(client, journalEntryId) {
  if (!journalEntryId) return;
  const cleared = await client.query(
    'select 1 from journal_lines where journal_entry_id = $1 and reconciliation_id is not null limit 1',
    [journalEntryId]
  );
  if (cleared.rows[0]) {
    const err = new Error('This transaction has been cleared in a bank reconciliation. Undo that reconciliation before changing or deleting it.');
    err.status = 409;
    throw err;
  }
  await client.query('delete from journal_entries where id = $1', [journalEntryId]);
}

async function getAccountBalance(companyId, accountId) {
  const accRes = await pool.query('select category from accounts where id = $1 and company_id = $2', [accountId, companyId]);
  if (!accRes.rows[0]) return 0;
  const { rows } = await pool.query(
    `select coalesce(sum(jl.debit),0) as debit, coalesce(sum(jl.credit),0) as credit
     from journal_lines jl join journal_entries je on je.id = jl.journal_entry_id
     where jl.account_id = $1 and je.company_id = $2`,
    [accountId, companyId]
  );
  const { debit, credit } = rows[0];
  return isDebitNormal(accRes.rows[0].category) ? Number(debit) - Number(credit) : Number(credit) - Number(debit);
}

// Balance summed across every account under one heading (e.g. all
// customer AR sub-accounts, or all Bank sub-accounts).
async function getHeadingBalance(companyId, heading) {
  const { rows } = await pool.query(
    `select a.category, coalesce(sum(jl.debit),0) as debit, coalesce(sum(jl.credit),0) as credit
     from accounts a
     left join journal_lines jl on jl.account_id = a.id
     left join journal_entries je on je.id = jl.journal_entry_id and je.company_id = a.company_id
     where a.company_id = $1 and a.heading = $2
     group by a.category`,
    [companyId, heading]
  );
  return rows.reduce((sum, r) => {
    const bal = isDebitNormal(r.category) ? Number(r.debit) - Number(r.credit) : Number(r.credit) - Number(r.debit);
    return sum + bal;
  }, 0);
}

// Full chronological ledger for one account, with running balance and
// an opening balance row (0 unless/until period-opening balances are
// introduced — the column exists so that feature can be added later
// without changing the shape of this response).
async function getAccountLedger(companyId, accountId, { from, till } = {}) {
  const accRes = await pool.query('select id, name, heading, category from accounts where id = $1 and company_id = $2', [accountId, companyId]);
  const account = accRes.rows[0];
  if (!account) return null;
  const debitNormal = isDebitNormal(account.category);

  // Opening balance: the net effect of everything strictly before `from`,
  // computed in SQL rather than by summing JS rows we'd otherwise discard.
  let openingBalance = 0;
  if (from) {
    const { rows } = await pool.query(
      `select coalesce(sum(jl.debit),0) as debit, coalesce(sum(jl.credit),0) as credit
       from journal_lines jl join journal_entries je on je.id = jl.journal_entry_id
       where jl.account_id = $1 and je.company_id = $2 and je.date < $3`,
      [accountId, companyId, from]
    );
    openingBalance = debitNormal ? Number(rows[0].debit) - Number(rows[0].credit) : Number(rows[0].credit) - Number(rows[0].debit);
  }

  const params = [accountId, companyId];
  let where = 'jl.account_id = $1 and je.company_id = $2';
  if (from) { params.push(from); where += ` and je.date >= $${params.length}`; }
  if (till) { params.push(till); where += ` and je.date <= $${params.length}`; }

  const { rows } = await pool.query(
    `select je.date, je.memo, je.source, je.reference, jl.debit, jl.credit
     from journal_lines jl
     join journal_entries je on je.id = jl.journal_entry_id
     where ${where}
     order by je.date asc, je.created_at asc`,
    params
  );

  let running = openingBalance;
  const entries = rows.map((r) => {
    running += debitNormal ? Number(r.debit) - Number(r.credit) : Number(r.credit) - Number(r.debit);
    return { ...r, runningBalance: running };
  });

  return { account, openingBalance, entries, closingBalance: running };
}

// Chart of Accounts for display: every heading, with its accounts and
// balances — except Accounts Receivable / Accounts Payable, which
// collapse to a single total (their detail lives in the ledger, one
// row per customer/supplier).
const DEFAULT_HEADINGS = {
  Assets: ['Cash', 'Bank', 'Inventory', 'Accounts Receivable', 'Fixed Assets'],
  Liabilities: ['Accounts Payable', 'Loans', 'Taxes Payable'],
  Equity: ["Owner's Capital", "Owner's Drawings", 'Retained Earnings'],
  Income: ['Sales', 'Service Income', 'Other Income'],
  Expenses: ['Rent', 'Salary', 'Electricity', 'Freight', 'Office Expenses', 'Discount Allowed', 'Cost of Goods Sold'],
};

// Fetch net balances for ALL accounts of a company in one query.
// Returns a Map<accountId, balance> using each account's debit-normal rule.
async function getAllBalances(companyId) {
  const { rows } = await pool.query(
    `select a.id, a.category,
            coalesce(sum(jl.debit), 0) as debit,
            coalesce(sum(jl.credit), 0) as credit
     from accounts a
     left join journal_lines jl on jl.account_id = a.id
     left join journal_entries je on je.id = jl.journal_entry_id and je.company_id = a.company_id
     where a.company_id = $1
     group by a.id, a.category`,
    [companyId]
  );
  const map = new Map();
  for (const r of rows) {
    const bal = isDebitNormal(r.category)
      ? Number(r.debit) - Number(r.credit)
      : Number(r.credit) - Number(r.debit);
    map.set(r.id, bal);
  }
  return map;
}

async function getChartOfAccounts(companyId) {
  const { rows: accounts } = await pool.query(
    'select id, name, heading, category, is_system from accounts where company_id = $1',
    [companyId]
  );
  const balances = await getAllBalances(companyId);
  const result = [];
  for (const [category, headings] of Object.entries(DEFAULT_HEADINGS)) {
    const headingRows = [];
    for (const heading of headings) {
      if (heading === 'Accounts Receivable' || heading === 'Accounts Payable') {
        const accs = accounts.filter((a) => a.heading === heading);
        const bal = accs.reduce((s, a) => s + (balances.get(a.id) || 0), 0);
        headingRows.push({ heading, collapsed: true, balance: bal, subAccountCount: accs.length });
      } else {
        const accs = accounts.filter((a) => a.heading === heading);
        headingRows.push({
          heading,
          collapsed: false,
          accounts: accs.map((a) => ({ id: a.id, name: a.name, is_system: a.is_system, balance: balances.get(a.id) || 0 })),
        });
      }
    }
    result.push({ category, headings: headingRows });
  }
  return result;
}

async function getTotals(companyId) {
  const { rows } = await pool.query(
    `select a.id, a.category, a.heading,
            coalesce(sum(jl.debit), 0) as debit,
            coalesce(sum(jl.credit), 0) as credit
     from accounts a
     left join journal_lines jl on jl.account_id = a.id
     left join journal_entries je on je.id = jl.journal_entry_id and je.company_id = a.company_id
     where a.company_id = $1 and a.category in ('Income', 'Expenses', 'Assets', 'Liabilities')
     group by a.id, a.category, a.heading`,
    [companyId]
  );

  let revenue = 0, cogs = 0, expenseTotal = 0, ar = 0, ap = 0;
  for (const r of rows) {
    const bal = isDebitNormal(r.category)
      ? Number(r.debit) - Number(r.credit)
      : Number(r.credit) - Number(r.debit);
    if (r.category === 'Income') revenue += bal;
    else if (r.category === 'Expenses' && r.heading === 'Cost of Goods Sold') cogs += bal;
    else if (r.category === 'Expenses') expenseTotal += bal;
    else if (r.category === 'Assets' && r.heading === 'Accounts Receivable') ar += bal;
    else if (r.category === 'Liabilities' && r.heading === 'Accounts Payable') ap += bal;
  }

  return { revenue, cogs, expenseTotal, ar, ap, profit: revenue - cogs - expenseTotal };
}

async function getBalanceSheet(companyId) {
  const balances = await getAllBalances(companyId);
  const { rows: accounts } = await pool.query(
    'select id, name, category from accounts where company_id=$1',
    [companyId]
  );

  const byCategory = (cat) =>
    accounts
      .filter((a) => a.category === cat)
      .map((a) => ({ name: a.name, balance: balances.get(a.id) || 0 }));

  const assets = byCategory('Assets');
  const liabilities = byCategory('Liabilities');
  const equityAccounts = byCategory('Equity');
  const t = await getTotals(companyId);
  const currentEarnings = t.revenue - t.cogs - t.expenseTotal;
  const totalAssets = assets.reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
  const totalEquity = equityAccounts.reduce((s, a) => s + a.balance, 0) + currentEarnings;
  return { assets, liabilities, equityAccounts, currentEarnings, totalAssets, totalLiabilities, totalEquity, balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01 };
}

module.exports = {
  isDebitNormal,
  ensureSubAccount,
  postJournal,
  reverseJournalEntry,
  getAccountBalance,
  getHeadingBalance,
  getAllBalances,
  getAccountLedger,
  getChartOfAccounts,
  getTotals,
  getBalanceSheet,
  DEFAULT_HEADINGS,
};
