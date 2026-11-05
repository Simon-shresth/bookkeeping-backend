const express = require('express');
const XLSX = require('xlsx');
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

// GET /api/ledger/export?accountId=...&from=...&till=...&allYears=...
router.get('/export', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    let { from, till } = parseRange(req);
    const allYears = req.query.allYears === 'true';
    const accountId = req.query.accountId; // can be a UUID or 'all' or empty

    if (!from && !allYears) {
      const fy = await getCurrentFiscalYear(companyId);
      if (fy) from = fy.start_date;
    }

    let rowsData = [];
    let filename = 'general-ledger-all-accounts.xlsx';

    if (accountId && accountId !== 'all') {
      const ledger = await getAccountLedger(companyId, accountId, { from, till });
      if (!ledger) return res.status(404).json({ error: 'Account not found' });
      const safeAccountName = ledger.account.name.replace(/[^A-Za-z0-9._-]/g, '_');
      const invoiceRef = ledger.entries.find(e => e.reference)?.reference || '';
      const safeInvoice = invoiceRef ? invoiceRef.replace(/[^A-Za-z0-9._-]/g, '_') + '-' : '';
      filename = `${safeInvoice}ledger-${safeAccountName}.xlsx`;

      // Format entries: Date, Account Headings, Account Name, Debit, Credit, Source, Memo/Reference
      rowsData = ledger.entries.map((e) => ({
        'Date': e.date,
        'Account Headings': ledger.account.heading,
        'Account Name': ledger.account.name,
        'Debit': Number(e.debit || 0),
        'Credit': Number(e.credit || 0),
        'Source': e.source,
        'Memo/Reference': e.reference ? `${e.memo} (${e.reference})` : e.memo,
      }));
    } else {
      // All accounts query
      const params = [companyId];
      let where = 'je.company_id = $1 and a.company_id = $1';
      if (from) { params.push(from); where += ` and je.date >= $${params.length}`; }
      if (till) { params.push(till); where += ` and je.date <= $${params.length}`; }

      const { rows } = await pool.query(
        `select je.date::text as date, a.heading as account_headings, a.name as account_name,
                jl.debit, jl.credit, je.source, je.memo, je.reference
         from journal_lines jl
         join journal_entries je on je.id = jl.journal_entry_id
         join accounts a on a.id = jl.account_id
         where ${where}
         order by je.date asc, je.created_at asc`,
        params
      );

      rowsData = rows.map((r) => ({
        'Date': r.date,
        'Account Headings': r.account_headings,
        'Account Name': r.account_name,
        'Debit': Number(r.debit || 0),
        'Credit': Number(r.credit || 0),
        'Source': r.source,
        'Memo/Reference': r.reference ? `${r.memo} (${r.reference})` : r.memo,
      }));
    }

    const worksheet = XLSX.utils.json_to_sheet(rowsData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'General Ledger');

    // Generate buffer
    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(excelBuffer);
  } catch (err) { next(err); }
});

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { withTransaction } = require('../db');
const { postJournal } = require('../services/ledger');

// POST /api/ledger/import
router.post('/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const companyId = req.user.company_id;
    const userId = req.user.id;

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty or missing data' });
    }

    let importedCount = 0;

    await withTransaction(async (client) => {
      // Group rows by date (and source/memo if desired, or all rows of the same date)
      const groupedByDate = {};

      for (const r of rows) {
        let dateStr = r['Date'];
        if (typeof dateStr === 'number') {
          // Excel serial date to YYYY-MM-DD
          const utcDays = Math.floor(dateStr - 25569);
          const dateObj = new Date(utcDays * 86400 * 1000);
          dateStr = dateObj.toISOString().split('T')[0];
        } else if (dateStr) {
          dateStr = String(dateStr).trim().split(' ')[0];
        }
        const date = dateStr;
        const heading = r['Account Headings'] || 'Office Expenses';
        const accountName = r['Account Name'];
        const debit = Number(r['Debit'] || 0);
        const credit = Number(r['Credit'] || 0);
        const source = r['Source'] || 'Import';
        const memoRef = r['Memo/Reference'] || 'Imported entry';

        if (!date || !accountName || (debit === 0 && credit === 0)) continue;

        // Determine category based on heading or default to Expenses
        const categoryMap = {
          'Cash': 'Assets',
          'Bank': 'Assets',
          'Inventory': 'Assets',
          'Accounts Receivable': 'Assets',
          'Fixed Assets': 'Assets',
          'Accounts Payable': 'Liabilities',
          'Loans': 'Liabilities',
          'Taxes Payable': 'Liabilities',
          "Owner's Capital": 'Equity',
          "Owner's Drawings": 'Equity',
          'Retained Earnings': 'Equity',
          'Sales': 'Income',
          'Service Income': 'Income',
          'Other Income': 'Income',
          'Rent': 'Expenses',
          'Salary': 'Expenses',
          'Electricity': 'Expenses',
          'Freight': 'Expenses',
          'Office Expenses': 'Expenses',
          'Discount Allowed': 'Expenses',
          'Cost of Goods Sold': 'Expenses'
        };
        const category = categoryMap[heading] || 'Expenses';

        // Check if account exists case-insensitively, otherwise create it
        let accRes = await client.query(
          'select id from accounts where company_id = $1 and lower(name) = lower($2)',
          [companyId, accountName]
        );
        let accountId;
        if (accRes.rows[0]) {
          accountId = accRes.rows[0].id;
        } else {
          const insAcc = await client.query(
            'insert into accounts (company_id, name, heading, category, is_system) values ($1, $2, $3, $4, false) returning id',
            [companyId, accountName, heading, category]
          );
          accountId = insAcc.rows[0].id;
        }

        if (!groupedByDate[date]) {
          groupedByDate[date] = {
            source,
            memo: memoRef,
            lines: []
          };
        }

        groupedByDate[date].lines.push({ accountId, debit, credit });
        importedCount++;
      }

      // Post each date group as a single journal entry with multiple lines
      for (const [date, group] of Object.entries(groupedByDate)) {
        await postJournal(client, {
          companyId,
          date,
          memo: group.memo,
          source: group.source,
          lines: group.lines,
          createdBy: userId
        });
      }
    });

    res.json({ success: true, importedCount });
  } catch (err) {
    next(err);
  }
});

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
    const invoiceRef = ledger.entries.find(e => e.reference)?.reference || '';
    const safeInvoice = invoiceRef ? invoiceRef.replace(/[^A-Za-z0-9._-]/g, '_') + '-' : '';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeInvoice}ledger-${safeName}.pdf"`);
    res.send(pdf);
  } catch (err) { next(err); }
});

module.exports = router;
