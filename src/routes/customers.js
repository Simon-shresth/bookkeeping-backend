const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { ensureSubAccount, getAccountBalance } = require('../services/ledger');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from customers where company_id=$1 order by name', [req.user.company_id]);
    const withBalance = await Promise.all(rows.map(async (c) => ({ ...c, outstanding: await getAccountBalance(req.user.company_id, c.account_id) })));
    res.json(withBalance);
  } catch (err) { next(err); }
});

const schema = z.object({ name: z.string().min(1), contact: z.string().optional() });

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const { name, contact } = schema.parse(req.body);
    const customer = await withTransaction(async (client) => {
      const accountId = await ensureSubAccount(client, req.user.company_id, name, 'Accounts Receivable', 'Assets');
      const { rows } = await client.query(
        'insert into customers (company_id, name, contact, account_id) values ($1,$2,$3,$4) returning *',
        [req.user.company_id, name, contact || null, accountId]
      );
      return rows[0];
    });
    res.status(201).json(customer);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A customer with this name already exists.' });
    next(err);
  }
});

// PUT /:id — editing the name migrates the linked account name too, so every
// historical journal line still resolves to the same (renamed) account.
router.put('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const { name, contact } = schema.parse(req.body);
    const updated = await withTransaction(async (client) => {
      const cur = await client.query('select * from customers where id=$1 and company_id=$2', [req.params.id, req.user.company_id]);
      if (!cur.rows[0]) return null;
      if (cur.rows[0].name !== name) {
        await client.query('update accounts set name=$1 where id=$2', [name, cur.rows[0].account_id]);
      }
      const { rows } = await client.query(
        'update customers set name=$1, contact=$2 where id=$3 returning *',
        [name, contact || null, req.params.id]
      );
      return rows[0];
    });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A customer with this name already exists.' });
    next(err);
  }
});

// DELETE — removes the customer record only. Their ledger account and
// transaction history are preserved (an accounting record should never
// silently vanish); it just won't show as an active customer any more.
router.delete('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const result = await pool.query('delete from customers where id=$1 and company_id=$2', [req.params.id, req.user.company_id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'This customer has invoices on record and cannot be deleted. Financial history must be preserved.' });
    next(err);
  }
});

module.exports = router;
