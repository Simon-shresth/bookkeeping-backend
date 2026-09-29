const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { postJournal, reverseJournalEntry } = require('../services/ledger');
const { audit } = require('../services/audit');
const { companyToday } = require('../services/dates');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const params = [req.user.company_id];
    let where = 'where pu.company_id = $1';
    if (q) {
      params.push(`%${q}%`);
      where += ` and (pu.invoice_number ilike $2 or pu.pragyapan_number ilike $2 or s.name ilike $2 or p.name ilike $2)`;
    }
    const { rows } = await pool.query(
      `select pu.*, s.name as supplier_name, p.name as product_name, a.name as account_name
       from purchase_invoices pu
       join suppliers s on s.id = pu.supplier_id
       join products p on p.id = pu.product_id
       left join accounts a on a.id = pu.payment_account_id
       ${where}
       order by pu.date desc, pu.created_at desc`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const purchaseSchema = z.object({
  invoiceNumber: z.string().optional(),
  pragyapanNumber: z.string().optional(),
  supplierId: z.string().uuid(),
  productId: z.string().uuid().optional(),
  newProduct: z.object({
    name: z.string().min(1),
    sellPrice: z.number().min(0).optional(),
    minStock: z.number().min(0).default(0),
  }).optional(),
  qty: z.number().positive(),
  unitPrice: z.number().min(0),
  paidAmount: z.number().min(0).default(0),
  accountId: z.string().uuid(),
}).refine((b) => b.productId || b.newProduct, { message: 'Provide either productId or newProduct' });

async function createPurchaseWithinTx(client, companyId, userId, body) {
  const supRes = await client.query('select * from suppliers where id=$1 and company_id=$2', [body.supplierId, companyId]);
  const supplier = supRes.rows[0];
  if (!supplier) { const e = new Error('Supplier not found'); e.status = 404; throw e; }

  let product;
  if (body.newProduct) {
    const { rows } = await client.query(
      `insert into products (company_id, name, purchase_price, sell_price, stock, min_stock)
       values ($1,$2,$3,$4,0,$5) returning *`,
      [companyId, body.newProduct.name, body.unitPrice, body.newProduct.sellPrice ?? body.unitPrice, body.newProduct.minStock]
    );
    product = rows[0];
  } else {
    const { rows } = await client.query('select * from products where id=$1 and company_id=$2 for update', [body.productId, companyId]);
    product = rows[0];
    if (!product) { const e = new Error('Product not found'); e.status = 404; throw e; }
    await client.query('update products set purchase_price=$1 where id=$2', [body.unitPrice, product.id]);
  }

  const total = body.unitPrice * body.qty;
  const paidAmount = Math.min(Math.max(body.paidAmount, 0), total);
  const creditAmount = total - paidAmount;

  await client.query('update products set stock = stock + $1 where id = $2', [body.qty, product.id]);

  const invAcct = await client.query("select id from accounts where company_id=$1 and heading='Inventory' limit 1", [companyId]);
  const lines = [{ accountId: invAcct.rows[0].id, debit: total, credit: 0 }];
  if (paidAmount > 0) lines.push({ accountId: body.accountId, debit: 0, credit: paidAmount });
  if (creditAmount > 0) lines.push({ accountId: supplier.account_id, debit: 0, credit: creditAmount });

  const date = await companyToday(client, companyId);
  const memo = `Purchase from ${supplier.name} — ${body.qty} x ${product.name}` +
    (body.invoiceNumber ? ' — Invoice ' + body.invoiceNumber : '') +
    (body.pragyapanNumber ? ' — PP ' + body.pragyapanNumber : '');
  const entry = await postJournal(client, { companyId, date, memo, source: 'Purchase', reference: body.invoiceNumber, lines, createdBy: userId });

  const { rows } = await client.query(
    `insert into purchase_invoices
       (company_id, invoice_number, pragyapan_number, supplier_id, product_id, qty, unit_price, total, paid_amount, credit_amount, payment_account_id, journal_entry_id, date, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [companyId, body.invoiceNumber || null, body.pragyapanNumber || null, body.supplierId, product.id, body.qty, body.unitPrice, total, paidAmount, creditAmount, body.accountId, entry?.id || null, date, userId]
  );
  return rows[0];
}

async function reversePurchaseWithinTx(client, companyId, purchaseId) {
  const { rows } = await client.query('select * from purchase_invoices where id=$1 and company_id=$2', [purchaseId, companyId]);
  const purchase = rows[0];
  if (!purchase) return null;
  await client.query('update products set stock = stock - $1 where id = $2', [purchase.qty, purchase.product_id]);
  await reverseJournalEntry(client, purchase.journal_entry_id);
  await client.query('delete from purchase_invoices where id = $1', [purchaseId]);
  return purchase;
}

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const body = purchaseSchema.parse(req.body);
    const purchase = await withTransaction(async (client) => {
      const p = await createPurchaseWithinTx(client, req.user.company_id, req.user.id, body);
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'create', entity: 'purchase_invoice', entityId: p.id, details: { invoiceNumber: p.invoice_number, pragyapanNumber: p.pragyapan_number, total: p.total, paid: p.paid_amount } });
      return p;
    });
    res.status(201).json(purchase);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const body = purchaseSchema.parse(req.body);
    const purchase = await withTransaction(async (client) => {
      const old = await reversePurchaseWithinTx(client, req.user.company_id, req.params.id);
      if (!old) { const e = new Error('Not found'); e.status = 404; throw e; }
      const p = await createPurchaseWithinTx(client, req.user.company_id, req.user.id, body);
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'update', entity: 'purchase_invoice', entityId: p.id, details: { replaced: old.id, before: { invoiceNumber: old.invoice_number, total: old.total, qty: old.qty }, after: { invoiceNumber: p.invoice_number, total: p.total, qty: p.qty } } });
      return p;
    });
    res.json(purchase);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const purchase = await withTransaction(async (client) => {
      const old = await reversePurchaseWithinTx(client, req.user.company_id, req.params.id);
      if (old) await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'delete', entity: 'purchase_invoice', entityId: old.id, details: { invoiceNumber: old.invoice_number, total: old.total, qty: old.qty } });
      return old;
    });
    if (!purchase) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
