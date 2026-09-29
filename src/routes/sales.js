const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { postJournal, reverseJournalEntry } = require('../services/ledger');
const { audit } = require('../services/audit');
const { companyToday } = require('../services/dates');
const { buildSalesInvoicePdf } = require('../services/invoicePdf');

const router = express.Router();

// GET /api/sales?q=search — list with customer/product names joined, newest first
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const params = [req.user.company_id];
    let where = 'where s.company_id = $1';
    if (q) {
      params.push(`%${q}%`);
      where += ` and (s.invoice_number ilike $2 or c.name ilike $2 or p.name ilike $2)`;
    }
    const { rows } = await pool.query(
      `select s.*, c.name as customer_name, p.name as product_name, a.name as account_name
       from sales_invoices s
       join customers c on c.id = s.customer_id
       join products p on p.id = s.product_id
       left join accounts a on a.id = s.payment_account_id
       ${where}
       order by s.date desc, s.created_at desc`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/sales/:id/pdf — printable invoice
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    const { rows } = await pool.query(
      `select s.*, c.name as customer_name, c.contact as customer_contact, p.name as product_name,
              a.name as account_name, co.name as company_name, co.currency
       from sales_invoices s
       join customers c on c.id = s.customer_id
       join products p on p.id = s.product_id
       join companies co on co.id = s.company_id
       left join accounts a on a.id = s.payment_account_id
       where s.id = $1 and s.company_id = $2`,
      [req.params.id, companyId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Not found' });

    const pdf = await buildSalesInvoicePdf({
      company: { name: r.company_name, currency: r.currency },
      sale: r,
      customer: { name: r.customer_name, contact: r.customer_contact },
      product: { name: r.product_name },
      paymentAccount: r.account_name ? { name: r.account_name } : null,
    });

    const safeName = String(r.invoice_number || r.id).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${safeName}.pdf"`);
    res.send(pdf);
  } catch (err) { next(err); }
});

const saleSchema = z.object({
  invoiceNumber: z.string().optional(),
  customerId: z.string().uuid(),
  productId: z.string().uuid(),
  qty: z.number().positive(),
  price: z.number().min(0),
  paidAmount: z.number().min(0).default(0),
  accountId: z.string().uuid(), // Cash/Bank account the paid portion lands in
});

// Shared logic for both create and update: validates stock, computes
// totals, adjusts inventory, and posts the compound journal entry
// (payment/AR split, Sales revenue, COGS/Inventory relief).
async function createSaleWithinTx(client, companyId, userId, body) {
  const prodRes = await client.query('select * from products where id=$1 and company_id=$2 for update', [body.productId, companyId]);
  const product = prodRes.rows[0];
  if (!product) { const e = new Error('Product not found'); e.status = 404; throw e; }
  if (Number(product.stock) < body.qty) {
    const e = new Error(`Insufficient stock: only ${product.stock} of "${product.name}" available.`);
    e.status = 400; throw e;
  }
  const custRes = await client.query('select * from customers where id=$1 and company_id=$2', [body.customerId, companyId]);
  const customer = custRes.rows[0];
  if (!customer) { const e = new Error('Customer not found'); e.status = 404; throw e; }

  const total = body.price * body.qty;
  const cost = Number(product.purchase_price) * body.qty;
  const paidAmount = Math.min(Math.max(body.paidAmount, 0), total);
  const creditAmount = total - paidAmount;

  await client.query('update products set stock = stock - $1 where id = $2', [body.qty, product.id]);

  const lines = [];
  if (paidAmount > 0) lines.push({ accountId: body.accountId, debit: paidAmount, credit: 0 });
  if (creditAmount > 0) lines.push({ accountId: customer.account_id, debit: creditAmount, credit: 0 });
  const salesAcct = await client.query("select id from accounts where company_id=$1 and heading='Sales' limit 1", [companyId]);
  lines.push({ accountId: salesAcct.rows[0].id, debit: 0, credit: total });
  if (cost > 0) {
    const cogsAcct = await client.query("select id from accounts where company_id=$1 and heading='Cost of Goods Sold' limit 1", [companyId]);
    const invAcct = await client.query("select id from accounts where company_id=$1 and heading='Inventory' limit 1", [companyId]);
    lines.push({ accountId: cogsAcct.rows[0].id, debit: cost, credit: 0 });
    lines.push({ accountId: invAcct.rows[0].id, debit: 0, credit: cost });
  }

  const date = await companyToday(client, companyId);
  const memo = `Sale to ${customer.name} — ${body.qty} x ${product.name}${body.invoiceNumber ? ' — Invoice ' + body.invoiceNumber : ''}`;
  const entry = await postJournal(client, { companyId, date, memo, source: 'Sale', reference: body.invoiceNumber, lines, createdBy: userId });

  const { rows } = await client.query(
    `insert into sales_invoices
       (company_id, invoice_number, customer_id, product_id, qty, price, total, cost, paid_amount, credit_amount, payment_account_id, journal_entry_id, date, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [companyId, body.invoiceNumber || null, body.customerId, body.productId, body.qty, body.price, total, cost, paidAmount, creditAmount, body.accountId, entry?.id || null, date, userId]
  );
  return rows[0];
}

async function reverseSaleWithinTx(client, companyId, saleId) {
  const { rows } = await client.query('select * from sales_invoices where id=$1 and company_id=$2', [saleId, companyId]);
  const sale = rows[0];
  if (!sale) return null;
  await client.query('update products set stock = stock + $1 where id = $2', [sale.qty, sale.product_id]);
  await reverseJournalEntry(client, sale.journal_entry_id);
  await client.query('delete from sales_invoices where id = $1', [saleId]);
  return sale;
}

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const body = saleSchema.parse(req.body);
    const sale = await withTransaction(async (client) => {
      const s = await createSaleWithinTx(client, req.user.company_id, req.user.id, body);
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'create', entity: 'sales_invoice', entityId: s.id, details: { invoiceNumber: s.invoice_number, total: s.total, paid: s.paid_amount } });
      return s;
    });
    res.status(201).json(sale);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PUT /:id — fully reverses the old sale (stock + journal) then re-creates it
// with the new values, inside one transaction, so it's never possible to end
// up in a half-updated state.
router.put('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const body = saleSchema.parse(req.body);
    const sale = await withTransaction(async (client) => {
      const old = await reverseSaleWithinTx(client, req.user.company_id, req.params.id);
      if (!old) { const e = new Error('Not found'); e.status = 404; throw e; }
      const s = await createSaleWithinTx(client, req.user.company_id, req.user.id, body);
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'update', entity: 'sales_invoice', entityId: s.id, details: { replaced: old.id, before: { invoiceNumber: old.invoice_number, total: old.total, qty: old.qty }, after: { invoiceNumber: s.invoice_number, total: s.total, qty: s.qty } } });
      return s;
    });
    res.json(sale);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const sale = await withTransaction(async (client) => {
      const old = await reverseSaleWithinTx(client, req.user.company_id, req.params.id);
      if (old) await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'delete', entity: 'sales_invoice', entityId: old.id, details: { invoiceNumber: old.invoice_number, total: old.total, qty: old.qty } });
      return old;
    });
    if (!sale) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
