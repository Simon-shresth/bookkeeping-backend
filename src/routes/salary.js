const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { postJournal, ensureSubAccount } = require('../services/ledger');
const { audit } = require('../services/audit');

const router = express.Router();

// GET /api/salary — list all disbursements with their lines
router.get('/', async (req, res, next) => {
  try {
    const { rows: disbursements } = await pool.query(
      `select sd.*, a.name as payment_account_name
       from salary_disbursements sd
       join accounts a on a.id = sd.payment_account_id
       where sd.company_id=$1
       order by sd.date desc, sd.created_at desc`,
      [req.user.company_id]
    );
    if (!disbursements.length) return res.json([]);

    const ids = disbursements.map((d) => d.id);
    const { rows: lines } = await pool.query(
      `select sdl.*, e.name as employee_name
       from salary_disbursement_lines sdl
       join employees e on e.id = sdl.employee_id
       where sdl.disbursement_id = any($1::uuid[])`,
      [ids]
    );
    const byDisbursement = {};
    for (const l of lines) (byDisbursement[l.disbursement_id] ||= []).push(l);

    res.json(disbursements.map((d) => ({ ...d, lines: byDisbursement[d.id] || [] })));
  } catch (err) { next(err); }
});

const lineSchema = z.object({
  employeeId: z.string().uuid(),
  amount: z.number().min(0),
});

const disburseSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM'),
  date: z.string(),
  paymentAccountId: z.string().uuid(),
  remark: z.string().optional(),
  lines: z.array(lineSchema).min(1),
});

// POST /api/salary — disburse salaries for a month
router.post('/', requireRole('accountant'), async (req, res, next) => {
  try {
    const body = disburseSchema.parse(req.body);
    const totalAmount = body.lines.reduce((s, l) => s + l.amount, 0);
    if (totalAmount <= 0) return res.status(400).json({ error: 'Total salary amount must be greater than zero.' });

    const result = await withTransaction(async (client) => {
      // Ensure the Salary expense account exists (system account)
      const { rows: salaryAccRows } = await client.query(
        "select id from accounts where company_id=$1 and heading='Salary' and is_system=true limit 1",
        [req.user.company_id]
      );
      if (!salaryAccRows[0]) {
        const err = new Error('Salary expense account not found. Run the account seed first.');
        err.status = 400;
        throw err;
      }
      const salaryExpenseAccountId = salaryAccRows[0].id;

      // Post a single journal entry: debit Salary expense, credit payment account
      const journalEntry = await postJournal(client, {
        companyId: req.user.company_id,
        date: body.date,
        memo: `Salary disbursement — ${body.month}`,
        remark: body.remark || null,
        source: 'Salary',
        lines: [
          { accountId: salaryExpenseAccountId, debit: totalAmount, credit: 0 },
          { accountId: body.paymentAccountId, debit: 0, credit: totalAmount },
        ],
        createdBy: req.user.id,
      });

      // Insert disbursement header
      const { rows: [disbursement] } = await client.query(
        `insert into salary_disbursements
           (company_id, month, payment_account_id, total_amount, journal_entry_id, date, created_by)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [req.user.company_id, body.month, body.paymentAccountId, totalAmount, journalEntry.id, body.date, req.user.id]
      );

      // Insert per-employee lines
      for (const line of body.lines) {
        await client.query(
          'insert into salary_disbursement_lines (disbursement_id, employee_id, amount) values ($1,$2,$3)',
          [disbursement.id, line.employeeId, line.amount]
        );
      }

      await audit(client, {
        companyId: req.user.company_id,
        userId: req.user.id,
        action: 'create',
        entity: 'salary_disbursement',
        entityId: disbursement.id,
        details: { month: body.month, total: totalAmount, employees: body.lines.length },
      });

      return disbursement;
    });

    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/salary/:id — reverse a disbursement
router.delete('/:id', requireRole('accountant'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'select * from salary_disbursements where id=$1 and company_id=$2',
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    await withTransaction(async (client) => {
      const { reverseJournalEntry } = require('../services/ledger');
      await reverseJournalEntry(client, rows[0].journal_entry_id);
      await client.query('delete from salary_disbursements where id=$1', [req.params.id]);
      await audit(client, {
        companyId: req.user.company_id,
        userId: req.user.id,
        action: 'delete',
        entity: 'salary_disbursement',
        entityId: req.params.id,
        details: { month: rows[0].month },
      });
    });

    res.status(204).end();
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
