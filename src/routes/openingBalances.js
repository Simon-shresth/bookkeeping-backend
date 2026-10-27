const express = require('express');
const { z } = require('zod');
const multer = require('multer');
const XLSX = require('xlsx');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { postJournal, reverseJournalEntry, DEFAULT_HEADINGS } = require('../services/ledger');
const { audit } = require('../services/audit');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

// POST /api/opening-balances/bulk-import — import opening balances from CSV/Excel file
// Format: Account Name, Heading, Amount, Date
// If account doesn't exist, creates it under the appropriate category based on heading.
router.post('/bulk-import', requireRole('accountant'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const companyId = req.user.company_id;
    const fileExt = req.file.originalname.split('.').pop().toLowerCase();

    // Parse file based on extension
    let rows = [];
    try {
      if (fileExt === 'csv') {
        // Simple CSV parser
        const text = req.file.buffer.toString('utf-8');
        const lines = text.trim().split('\n');
        rows = lines.slice(1).map((line) => {
          const parts = line.split(',').map(p => p.trim().replace(/^["']|["']$/g, ''));
          return {
            accountName: parts[0],
            heading: parts[1],
            amount: parseFloat(parts[2]),
            date: parts[3],
          };
        }).filter(r => r.accountName && r.heading && !isNaN(r.amount) && r.date);
      } else if (fileExt === 'xlsx' || fileExt === 'xls') {
        // Parse Excel
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);

        console.log('First row from XLSX:', JSON.stringify(data[0], null, 2));
        console.log('XLSX column keys:', data.length > 0 ? Object.keys(data[0]) : 'no rows');

        rows = data
          .map((row) => {
            // Normalize keys: XLSX may have different casing or spaces
            // Create a normalized lookup object (case-insensitive, whitespace-tolerant)
            const normalized = {};
            Object.entries(row).forEach(([key, val]) => {
              const normalizedKey = key.toLowerCase().trim();
              normalized[normalizedKey] = val;
            });

            // Handle Excel date serial numbers
            let dateStr = normalized['date'];
            if (typeof dateStr === 'number') {
              // Excel date serial to JS date
              const excelEpoch = new Date(1899, 11, 30);
              const jsDate = new Date(excelEpoch.getTime() + dateStr * 86400000);
              dateStr = jsDate.toISOString().split('T')[0];
            }

            return {
              accountName: normalized['account name'],
              heading: normalized['heading'],
              amount: parseFloat(normalized['amount']),
              date: String(dateStr || ''),
            };
          })
          .filter(r => r.accountName && r.heading && !isNaN(r.amount) && r.date);
      } else {
        return res.status(400).json({ error: 'Unsupported file format. Use CSV or XLSX.' });
      }
    } catch (parseErr) {
      console.error('File parse error:', parseErr);
      return res.status(400).json({ error: `Failed to parse file: ${parseErr.message}` });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: 'No valid data rows found. Check file format.' });
    }

    console.log(`Bulk import: Processing ${rows.length} rows for company ${companyId}`);
    console.log('Parsed rows:', JSON.stringify(rows, null, 2));

    // Process all rows in a single transaction for atomicity
    const results = [];
    const errors = [];

    try {
      await withTransaction(async (client) => {
        // Fetch Retained Earnings once (needed for all rows)
        const { rows: eq } = await client.query(
          "select id from accounts where company_id=$1 and heading='Retained Earnings' and is_system=true limit 1",
          [companyId]
        );
        if (!eq[0]) {
          throw new Error('Retained Earnings account not found — run company setup first.');
        }
        const equityId = eq[0].id;

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          console.log(`Processing row ${i + 1}:`, row);
          try {
            // Find category for this heading
            let category = null;
            for (const [cat, headings] of Object.entries(DEFAULT_HEADINGS)) {
              if (headings.includes(row.heading)) {
                category = cat;
                break;
              }
            }
            if (!category) {
              throw new Error(`Unknown heading: "${row.heading}". Must exactly match one of: Cash, Bank, Inventory, Accounts Receivable, Fixed Assets, Accounts Payable, Loans, Taxes Payable, Owner's Capital, Owner's Drawings, Retained Earnings, Sales, Service Income, Other Income, Rent, Salary, Electricity, Freight, Office Expenses, Discount Allowed, Cost of Goods Sold.`);
            }

            // Validate date format strictly: YYYY-MM-DD
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date))) {
              throw new Error(`Invalid date format for account "${row.accountName}" at row ${i + 2}: "${row.date}". Expected YYYY-MM-DD (e.g., 2026-01-01).`);
            }

            // Find or create account
            let { rows: existing } = await client.query(
              'select id, name, category from accounts where company_id=$1 and name=$2',
              [companyId, row.accountName]
            );

            let accountId;
            let isNewAccount = false;
            if (existing[0]) {
              accountId = existing[0].id;
            } else {
              // Create new account
              const { rows: created } = await client.query(
                'insert into accounts (company_id, name, heading, category, is_system) values ($1,$2,$3,$4,false) returning id',
                [companyId, row.accountName, row.heading, category]
              );
              accountId = created[0].id;
              isNewAccount = true;
            }

            // If new account under Accounts Receivable, also create Customer
            if (isNewAccount && row.heading === 'Accounts Receivable') {
              await client.query(
                'insert into customers (company_id, name, contact, account_id) values ($1,$2,$3,$4)',
                [companyId, row.accountName, null, accountId]
              );
            }

            // If new account under Accounts Payable, also create Supplier
            if (isNewAccount && row.heading === 'Accounts Payable') {
              await client.query(
                'insert into suppliers (company_id, name, contact, account_id) values ($1,$2,$3,$4)',
                [companyId, row.accountName, null, accountId]
              );
            }

            // Reverse any previous opening balance for this account
            const { rows: prevOb } = await client.query(
              'select * from opening_balances where company_id=$1 and account_id=$2',
              [companyId, accountId]
            );
            if (prevOb[0]?.journal_entry_id) {
              await reverseJournalEntry(client, prevOb[0].journal_entry_id);
            }

            const amount = row.amount;
            if (Math.abs(amount) < 0.005) {
              // Delete if zero
              await client.query(
                'delete from opening_balances where company_id=$1 and account_id=$2',
                [companyId, accountId]
              );
              results.push({ accountName: row.accountName, amount, status: 'skipped (zero)' });
              continue;
            }

            // Build journal lines
            const { isDebitNormal } = require('../services/ledger');
            const debitNormal = isDebitNormal(category);
            const absAmount = Math.abs(amount);
            const isPositive = amount > 0;

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
              date: row.date,
              memo: `Opening balance — ${row.accountName}`,
              source: 'Opening Balance Bulk Import',
              lines,
              createdBy: req.user.id,
            });

            // Upsert opening_balances record
            const { rows: ob } = await client.query(
              `insert into opening_balances (company_id, account_id, amount, date, journal_entry_id, created_by)
               values ($1,$2,$3,$4,$5,$6)
               on conflict (company_id, account_id)
               do update set amount=$3, date=$4, journal_entry_id=$5, created_by=$6
               returning *`,
              [companyId, accountId, amount, row.date, entry?.id || null, req.user.id]
            );

            await audit(client, {
              companyId,
              userId: req.user.id,
              action: prevOb[0] ? 'update' : 'create',
              entity: 'opening_balance',
              entityId: ob[0].id,
              details: { accountId, accountName: row.accountName, amount, date: row.date, source: 'bulk_import' },
            });

            results.push({ accountName: row.accountName, amount, status: 'imported' });
          } catch (err) {
            console.error(`Error processing row ${i + 2}:`, err);
            // Throw to abort entire transaction — user must fix all errors
            throw new Error(`Row ${i + 2} (${row.accountName || 'unknown'}): ${err.message}`);
          }
        }
      });
    } catch (err) {
      console.error('Transaction error:', err);
      return res.status(400).json({ error: `Failed to process file: ${err.message}` });
    }

    // If there were errors, return 400 so frontend shows the error
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0].error });
    }

    res.json({ imported: results.length, errors: [], results });
  } catch (err) {
    console.error('Bulk import error:', err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/opening-balances/template — download a template CSV file
router.get('/template', (req, res) => {
  const template = 'Account Name,Heading,Amount,Date\nCash,Cash,10000.00,2026-01-01\nBank Account,Bank,50000.00,2026-01-01\nLoan,Loans,-30000.00,2026-01-01\nOwner Capital,Owner\'s Capital,-30000.00,2026-01-01';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="opening-balances-template.csv"');
  res.send(template);
});

module.exports = router;
