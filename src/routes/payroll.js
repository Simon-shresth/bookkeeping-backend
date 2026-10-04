const express = require('express');
const router = express.Router();
const db = require('../db');

// 1. Get all employees
router.get('/employees', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM employees ORDER BY is_active DESC, name ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Create a new employee
router.post('/employees', async (req, res) => {
  try {
    const { name, designation, phone, email, base_salary, bank_account_no } = req.body;
    const result = await db.query(
      `INSERT INTO employees (name, designation, phone, email, base_salary, bank_account_no)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, designation || '', phone || '', email || '', base_salary || 0, bank_account_no || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get payroll history
router.get('/history', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pr.*, 
        (SELECT json_agg(ss.*) FROM salary_slips ss WHERE ss.payroll_run_id = pr.id) AS slips
       FROM payroll_runs pr
       ORDER BY pr.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Batch Disburse Salary for All Active Employees
router.post('/disburse', async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { month_year, payment_method, notes, employee_adjustments } = req.body;
    // employee_adjustments = [{ employee_id, bonus, deductions }]

    // Check if payroll for this month was already disbursed
    const checkRun = await client.query(
      `SELECT id FROM payroll_runs WHERE month_year = $1`,
      [month_year]
    );
    if (checkRun.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Salary for ${month_year} has already been disbursed.` });
    }

    // Fetch all active employees
    const empRes = await client.query(
      `SELECT * FROM employees WHERE is_active = TRUE`
    );
    const activeEmployees = empRes.rows;

    if (activeEmployees.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No active employees found for salary disbursement.' });
    }

    // Compute total disbursement
    let totalPayrollAmount = 0;
    const processedSlips = activeEmployees.map((emp) => {
      const adj = (employee_adjustments || []).find((a) => a.employee_id === emp.id) || {};
      const bonus = Number(adj.bonus) || 0;
      const deductions = Number(adj.deductions) || 0;
      const base = Number(emp.base_salary) || 0;
      const net = Math.max(0, base + bonus - deductions);

      totalPayrollAmount += net;

      return {
        employee_id: emp.id,
        employee_name: emp.name,
        base_salary: base,
        allowance_bonus: bonus,
        deductions: deductions,
        net_salary: net,
      };
    });

    // A. Post General Ledger Journal Entry
    const refNo = `PAY-${month_year}`;
    const journalRes = await client.query(
      `INSERT INTO journal_entries (reference_number, description, entry_date)
       VALUES ($1, $2, CURRENT_DATE) RETURNING id`,
      [refNo, `Salary Disbursement for ${month_year} (${activeEmployees.length} employees)`]
    );
    const journalId = journalRes.rows[0].id;

    // Debit: Salary & Wages Expense Account (Code '5010')
    await client.query(
      `INSERT INTO ledger_entries (journal_id, account_id, debit, credit)
       VALUES ($1, (SELECT id FROM accounts WHERE code = '5010' LIMIT 1), $2, 0)`,
      [journalId, totalPayrollAmount]
    );

    // Credit: Cash (Code '1010') or Bank Account (Code '1020')
    const creditAccountCode = payment_method === 'cash' ? '1010' : '1020';
    await client.query(
      `INSERT INTO ledger_entries (journal_id, account_id, debit, credit)
       VALUES ($1, (SELECT id FROM accounts WHERE code = $2 LIMIT 1), 0, $3)`,
      [journalId, creditAccountCode, totalPayrollAmount]
    );

    // B. Create Payroll Run Record
    const runRes = await client.query(
      `INSERT INTO payroll_runs (month_year, payment_method, total_amount, journal_id, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [month_year, payment_method || 'bank', totalPayrollAmount, journalId, notes || '']
    );
    const runId = runRes.rows[0].id;

    // C. Create Salary Slips for each active employee
    for (const slip of processedSlips) {
      await client.query(
        `INSERT INTO salary_slips (payroll_run_id, employee_id, employee_name, base_salary, allowance_bonus, deductions, net_salary)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [runId, slip.employee_id, slip.employee_name, slip.base_salary, slip.allowance_bonus, slip.deductions, slip.net_salary]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      message: `Successfully disbursed salary for ${activeEmployees.length} employees.`,
      payroll_run_id: runId,
      total_amount: totalPayrollAmount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;