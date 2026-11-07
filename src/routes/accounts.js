const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { getChartOfAccounts, DEFAULT_HEADINGS } = require('../services/ledger');

const router = express.Router();

// GET /api/accounts — full Chart of Accounts with live balances (read-only view)
router.get('/', async (req, res, next) => {
  try {
    res.json(await getChartOfAccounts(req.user.company_id));
  } catch (err) { next(err); }
});

// GET /api/accounts/options — flat list, grouped by heading, for populating
// dropdowns (e.g. in the Journal Entry form).
router.get('/options', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'select id, name, heading, category from accounts where company_id=$1 order by category, heading, name',
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const createSchema = z.object({
  name: z.string().min(1),
  heading: z.string().min(1),
});

// POST /api/accounts — create a new sub-account under an existing heading
// (e.g. a second bank account). Accounts Receivable / Accounts Payable are
// blocked here since those are managed only via Customers/Suppliers.
router.post('/', requireRole('accountant'), async (req, res, next) => {
  try {
    const { name, heading } = createSchema.parse(req.body);
    if (heading === 'Accounts Receivable' || heading === 'Accounts Payable') {
      return res.status(400).json({ error: 'Accounts Receivable and Accounts Payable accounts are created automatically from Customers and Suppliers.' });
    }
    const category = Object.entries(DEFAULT_HEADINGS).find(([, heads]) => heads.includes(heading))?.[0];
    if (!category) return res.status(400).json({ error: `Unknown heading: ${heading}` });

    const { rows } = await pool.query(
      'insert into accounts (company_id, name, heading, category) values ($1,$2,$3,$4) returning *',
      [req.user.company_id, name, heading, category]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this name already exists.' });
    next(err);
  }
});

// DELETE /api/accounts/:id — remove a user-created account only if it has no
// transactions and is not a system account. Also removes linked customer or supplier
// records if they have no financial history.
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        'select is_system, name from accounts where id=$1 and company_id=$2',
        [req.params.id, req.user.company_id]
      );
      if (!rows[0]) {
        const err = new Error('Not found');
        err.status = 404;
        throw err;
      }
      if (rows[0].is_system) {
        const err = new Error('System accounts cannot be deleted.');
        err.status = 400;
        throw err;
      }

      const { rows: used } = await client.query(
        'select 1 from journal_lines where account_id=$1 limit 1',
        [req.params.id]
      );
      if (used[0]) {
        const err = new Error('This account has transactions and cannot be deleted. Zero out the balance first or use it in a reversing journal entry.');
        err.status = 400;
        throw err;
      }

      // If linked to a customer, remove customer record (or verify no invoice/payment history)
      const { rows: refCustomer } = await client.query(
        'select id from customers where account_id=$1 and company_id=$2',
        [req.params.id, req.user.company_id]
      );
      if (refCustomer[0]) {
        const { rows: inv } = await client.query(
          'select 1 from sales_invoices where customer_id=$1 limit 1',
          [refCustomer[0].id]
        );
        if (inv[0]) {
          const err = new Error('This customer has sales invoices on record and cannot be deleted.');
          err.status = 400;
          throw err;
        }
        const { rows: pmt } = await client.query(
          'select 1 from payments where customer_id=$1 limit 1',
          [refCustomer[0].id]
        );
        if (pmt[0]) {
          const err = new Error('This customer has payments on record and cannot be deleted.');
          err.status = 400;
          throw err;
        }
        await client.query('delete from customers where id=$1 and company_id=$2', [refCustomer[0].id, req.user.company_id]);
      }

      // If linked to a supplier, remove supplier record (or verify no invoice/payment history)
      const { rows: refSupplier } = await client.query(
        'select id from suppliers where account_id=$1 and company_id=$2',
        [req.params.id, req.user.company_id]
      );
      if (refSupplier[0]) {
        const { rows: inv } = await client.query(
          'select 1 from purchase_invoices where supplier_id=$1 limit 1',
          [refSupplier[0].id]
        );
        if (inv[0]) {
          const err = new Error('This supplier has purchase invoices on record and cannot be deleted.');
          err.status = 400;
          throw err;
        }
        const { rows: pmt } = await client.query(
          'select 1 from payments where supplier_id=$1 limit 1',
          [refSupplier[0].id]
        );
        if (pmt[0]) {
          const err = new Error('This supplier has payments on record and cannot be deleted.');
          err.status = 400;
          throw err;
        }
        await client.query('delete from suppliers where id=$1 and company_id=$2', [refSupplier[0].id, req.user.company_id]);
      }

      await client.query('delete from accounts where id=$1 and company_id=$2', [req.params.id, req.user.company_id]);
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
