const express = require('express');
const { z } = require('zod');
const multer = require('multer');
const XLSX = require('xlsx');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { audit } = require('../services/audit');
const { companyToday } = require('../services/dates');
const { ensureSubAccount } = require('../services/ledger');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/cheques?customerId=
router.get('/', async (req, res, next) => {
  try {
    const params = [req.user.company_id];
    let where = 'where c.company_id = $1';
    if (req.query.customerId) {
      params.push(req.query.customerId);
      where += ' and c.customer_id = $2';
    }
    const { rows } = await pool.query(
      `select c.*, cust.name as customer_name
       from cheques c
       join customers cust on cust.id = c.customer_id
       ${where}
       order by c.cheque_date asc, c.created_at asc`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const schema = z.object({
  chequeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  customerId: z.string().uuid(),
  bankName: z.string().trim().min(1),
  chequeNumber: z.string().trim().min(1),
  amount: z.number().positive(),
  draweeName: z.string().trim().min(1),
  chequeOwner: z.string().trim().min(1),
  isCashed: z.boolean().default(false),
  cashedAmount: z.number().nonnegative().default(0),
  cashedDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal(''), z.null()]).optional().transform((v) => v || null),
}).transform((data) => {
  let isCashed = data.isCashed;
  let cashedAmount = data.cashedAmount;
  if (isCashed && cashedAmount === 0) {
    cashedAmount = data.amount;
  } else if (cashedAmount >= data.amount) {
    isCashed = true;
    cashedAmount = data.amount;
  }
  return { ...data, isCashed, cashedAmount };
});

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const body = schema.parse(req.body);
    const { rows } = await pool.query(
      `insert into cheques (company_id, cheque_date, customer_id, bank_name, cheque_number, amount, drawee_name, cheque_owner, is_cashed, cashed_amount, cashed_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [req.user.company_id, body.chequeDate, body.customerId, body.bankName, body.chequeNumber, body.amount, body.draweeName, body.chequeOwner, body.isCashed, body.cashedAmount, body.cashedDate]
    );
    await audit(pool, { companyId: req.user.company_id, userId: req.user.id, action: 'create', entity: 'cheque', entityId: rows[0].id, details: body });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const body = schema.parse(req.body);
    const { rows } = await pool.query(
      `update cheques set cheque_date=$1, customer_id=$2, bank_name=$3, cheque_number=$4, amount=$5, drawee_name=$6, cheque_owner=$7, is_cashed=$8, cashed_amount=$9, cashed_date=$10
       where id=$11 and company_id=$12 returning *`,
      [body.chequeDate, body.customerId, body.bankName, body.chequeNumber, body.amount, body.draweeName, body.chequeOwner, body.isCashed, body.cashedAmount, body.cashedDate, req.params.id, req.user.company_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await audit(pool, { companyId: req.user.company_id, userId: req.user.id, action: 'update', entity: 'cheque', entityId: rows[0].id, details: body });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

const cashSchema = z.object({
  isCashed: z.boolean().optional(),
  cashedAmount: z.number().nonnegative(),
  cashedDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal(''), z.null()]).optional().transform((v) => v || null),
});

// POST /api/cheques/:id/cash — record a cash event (full or partial payment).
// Updates the cheque's running cumulative state AND appends a row to
// cheque_cashings so the Cheques screen can show previous partial cash
// receipts while recording the next payment.
router.post('/:id/cash', requireRole('manager'), async (req, res, next) => {
  try {
    const body = cashSchema.parse(req.body);
    const cashDate = body.cashedDate || await companyToday(pool, req.user.company_id);
    const cheque = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(
        'select * from cheques where id = $1 and company_id = $2',
        [req.params.id, req.user.company_id]
      );
      if (existing.length === 0) { const e = new Error('Not found'); e.status = 404; throw e; }
      const ch = existing[0];
      const totalAmount = Number(ch.amount);
      let cashedAmount = body.cashedAmount;
      let isCashed = body.isCashed ?? (cashedAmount >= totalAmount);
      if (isCashed && cashedAmount === 0) cashedAmount = totalAmount;
      else if (cashedAmount >= totalAmount) { isCashed = true; cashedAmount = totalAmount; }

      const { rows } = await client.query(
        `update cheques set is_cashed = $1, cashed_amount = $2, cashed_date = $3
         where id = $4 and company_id = $5 returning *`,
        [isCashed, cashedAmount, cashDate, req.params.id, req.user.company_id]
      );
      const updated = rows[0];

      const { rows: cashRows } = await client.query(
        `insert into cheque_cashings (company_id, cheque_id, cash_date, amount, is_full)
         values ($1,$2,$3,$4,$5) returning *`,
        [req.user.company_id, req.params.id, cashDate, cashedAmount, isCashed]
      );

      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'cash_cheque', entity: 'cheque', entityId: req.params.id, details: { cashedAmount, cashDate, isCashed } });

      return { cheque: updated, cashing: cashRows[0] };
    });
    res.json(cheque);
  } catch (err) { next(err); }
});

// GET /api/cheques/:id/cashings — prior cash events (full / partial payments)
// recorded against this cheque, oldest first.
router.get('/:id/cashings', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select cc.id, cc.cheque_id, cc.cash_date::text as cash_date, cc.amount, cc.is_full, cc.created_at
       from cheque_cashings cc
       where cc.cheque_id = $1 and cc.company_id = $2
       order by cc.cash_date asc, cc.created_at asc`,
      [req.params.id, req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('delete from cheques where id=$1 and company_id=$2 returning id', [req.params.id, req.user.company_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await audit(pool, { companyId: req.user.company_id, userId: req.user.id, action: 'delete', entity: 'cheque', entityId: rows[0].id, details: {} });
    res.status(204).end();
  } catch (err) { next(err); }
});

// POST /api/cheques/import — bulk-import cheques from an Excel/CSV file.
// Expected columns (header row, order-independent): Date, Customer, Bank Name,
// Cheque Number, Amount, Drawee's Name, Owner of the Cheque.
// Customer matching is case-insensitive; a missing customer is created using the
// same logic as the Customers module's "Add" (ensureSubAccount + customers row).
router.post('/import', requireRole('manager'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const companyId = req.user.company_id;
    const fileExt = req.file.originalname.split('.').pop().toLowerCase();
    if (!['csv', 'xlsx', 'xls'].includes(fileExt)) {
      return res.status(400).json({ error: 'Unsupported file format. Use XLSX, XLS or CSV.' });
    }

    // ---- Parse the file into raw rows -------------------------------------
    let rawRows = [];
    try {
      if (fileExt === 'csv') {
        const text = req.file.buffer.toString('utf-8').replace(/^﻿/, '');
        const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
        const splitCsv = (line) => line.split(',').map((p) => p.trim().replace(/^["']|["']$/g, ''));
        const headers = splitCsv(lines[0]);
        rawRows = lines.slice(1).map((line) => {
          const cells = splitCsv(line);
          const obj = {};
          headers.forEach((h, i) => { obj[h] = cells[i]; });
          return obj;
        });
      } else {
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      }
    } catch (parseErr) {
      console.error('Cheque import parse error:', parseErr);
      return res.status(400).json({ error: `Failed to parse file: ${parseErr.message}` });
    }

    // Case/space/punctuation-insensitive column lookup so headers like
    // "Drewee's Name", "DREWEE'S NAMES" or "Drawee Name" all resolve.
    const getCol = (row, ...keys) => {
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const key of keys) {
        const target = norm(key);
        for (const [k, v] of Object.entries(row)) {
          if (norm(k) === target) return v;
        }
      }
      return undefined;
    };

    const pad = (n) => String(n).padStart(2, '0');
    const toIsoDate = (value) => {
      if (value === null || value === undefined || value === '') return null;
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        // Excel serial date (1900 date system, accounting for the 1900 leap bug).
        const utc = Math.round((value - 25569) * 86400 * 1000);
        return new Date(utc).toISOString().slice(0, 10);
      }
      const s = String(value).trim();
      let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); // YYYY-MM-DD / YYYY/MM/DD
      if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
      m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/); // DD/MM/YYYY or MM/DD/YYYY
      if (m) {
        let day = Number(m[1]);
        let month = Number(m[2]);
        let year = Number(m[3]);
        if (year < 100) year += 2000;
        if (month > 12 && day <= 12) [day, month] = [month, day]; // was MM/DD
        return `${year}-${pad(month)}-${pad(day)}`;
      }
      const parsed = new Date(s);
      if (!Number.isNaN(parsed.getTime())) {
        return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
      }
      return null;
    };

    const toAmount = (value) => {
      if (typeof value === 'number') return value;
      if (value === null || value === undefined) return NaN;
      const cleaned = String(value).replace(/[^0-9.\-]/g, '');
      return cleaned === '' ? NaN : Number(cleaned);
    };

    // ---- Validate every row first (atomic import) -------------------------
    const parsed = [];
    const errors = [];
    rawRows.forEach((row, idx) => {
      const lineNo = idx + 2; // +1 header, +1 for 1-based
      if (!row || Object.values(row).every((v) => v === '' || v === null || v === undefined)) return; // skip blank

      const customerName = String(getCol(row, 'customer', 'customers', 'customer name') ?? '').trim();
      const bankName = String(getCol(row, 'bank name', 'bank', 'bankname') ?? '').trim();
      const chequeNumber = String(getCol(row, 'cheque number', 'cheque no', 'cheque no.', 'chequenumber', 'cheque') ?? '').trim();
      const amount = toAmount(getCol(row, 'amount', 'cheque amount'));
      const draweeName = String(getCol(row, "drawee's name", "drawee's names", 'drawee name', 'drawee names', 'drawee', 'drew ee') ?? '').trim();
      const chequeOwner = String(getCol(row, 'owner of the cheque', 'owner of cheque', 'cheque owner', 'owner', "drawee's owner") ?? '').trim();
      const chequeDate = toIsoDate(getCol(row, 'date', 'cheque date'));

      const missing = [];
      if (!chequeDate) missing.push('Date');
      if (!customerName) missing.push('Customer');
      if (!bankName) missing.push('Bank Name');
      if (!chequeNumber) missing.push('Cheque Number');
      if (!Number.isFinite(amount) || amount <= 0) missing.push('Amount');
      if (!draweeName) missing.push("Drawee's Name");
      if (!chequeOwner) missing.push('Owner of the Cheque');

      if (missing.length) {
        errors.push(`Row ${lineNo}: missing or invalid ${missing.join(', ')}.`);
        return;
      }

      parsed.push({ lineNo, chequeDate, customerName, bankName, chequeNumber, amount, draweeName, chequeOwner });
    });

    if (parsed.length === 0) {
      return res.status(400).json({
        error: errors[0] || 'No valid data rows found. Check the file format and column headers.',
      });
    }

    // ---- Import in a single transaction (all-or-nothing) ------------------
    let imported = 0;
    let createdCustomers = 0;
    try {
      await withTransaction(async (client) => {
        // Cache customer lookups within this import.
        const customerCache = new Map(); // lowercased name -> id

        for (const row of parsed) {
          const key = row.customerName.toLowerCase();
          let customerId = customerCache.get(key);

          if (!customerId) {
            const { rows: existing } = await client.query(
              'select id from customers where company_id = $1 and lower(name) = lower($2) limit 1',
              [companyId, row.customerName]
            );
            if (existing[0]) {
              customerId = existing[0].id;
            } else {
              // Create the customer exactly like POST /api/customers does.
              const accountId = await ensureSubAccount(
                client, companyId, row.customerName, 'Accounts Receivable', 'Assets'
              );
              const { rows: created } = await client.query(
                'insert into customers (company_id, name, contact, account_id) values ($1,$2,$3,$4) returning id',
                [companyId, row.customerName, null, accountId]
              );
              customerId = created[0].id;
              createdCustomers++;
            }
            customerCache.set(key, customerId);
          }

          const { rows: inserted } = await client.query(
            `insert into cheques (company_id, cheque_date, customer_id, bank_name, cheque_number, amount, drawee_name, cheque_owner, is_cashed, cashed_amount, cashed_date)
             values ($1,$2,$3,$4,$5,$6,$7,$8,false,0,null) returning id`,
            [companyId, row.chequeDate, customerId, row.bankName, row.chequeNumber, row.amount, row.draweeName, row.chequeOwner]
          );

          await audit(client, {
            companyId, userId: req.user.id, action: 'create', entity: 'cheque',
            entityId: inserted[0].id,
            details: { ...row, source: 'import' },
          });
          imported++;
        }
      });
    } catch (err) {
      console.error('Cheque import failed:', err);
      const detail = err.detail ? `: ${err.detail}` : '';
      return res.status(400).json({ error: `Import failed: ${err.message}${detail}` });
    }

    res.json({ imported, createdCustomers, errors });
  } catch (err) { next(err); }
});

// GET /api/cheques/template — download a template CSV file
router.get('/template', (req, res) => {
  const template = 'Date,Customer,Bank Name,Cheque Number,Amount,Drawee\'s Name,Owner of the Cheque\n' +
    '2026-01-01,John Doe,Nabil Bank,00458291,1000.00,ABC Company,Jane Smith\n' +
    '2026-02-15,Acme Corp,First National Bank,00458292,5000.00,Global Manufacturing,John Smith';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="cheques-template.csv"');
  res.send(template);
});

module.exports = router;
