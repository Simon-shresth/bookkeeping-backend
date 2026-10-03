const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { postJournal, reverseJournalEntry } = require('../services/ledger');
const { createPaymentWithinTx, reverseLinkedPaymentsWithinTx } = require('../services/payments');
const { companyToday } = require('../services/dates');
const { audit } = require('../services/audit');

const router = express.Router();

async function attachLines(invoices) {
  if (!invoices.length) return invoices;
  const { rows: lines } = await pool.query(
    `select pl.*, p.name as product_name from purchase_invoice_lines pl join products p on p.id = pl.product_id
     where pl.purchase_invoice_id = any($1::uuid[]) order by pl.id`,
    [invoices.map((i) => i.id)]
  );
  const byInvoice = {};
  for (const l of lines) (byInvoice[l.purchase_invoice_id] ||= []).push(l);
  return invoices.map((i) => ({ ...i, lines: byInvoice[i.id] || [] }));
}

// GET /api/purchases?q=search
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const params = [req.user.company_id];
    let where = 'where pu.company_id = $1';
    if (q) {
      params.push(`%${q}%`);
      where += ` and (pu.invoice_number ilike $2 or pu.pragyapan_number ilike $2 or s.name ilike $2 or exists (
        select 1 from purchase_invoice_lines pl join products p on p.id = pl.product_id
        where pl.purchase_invoice_id = pu.id and p.name ilike $2
      ))`;
    }
    const { rows } = await pool.query(
      `select pu.*, s.name as supplier_name, a.name as account_name
       from purchase_invoices pu
       join suppliers s on s.id = pu.supplier_id
       left join accounts a on a.id = pu.payment_account_id
       ${where}
       order by pu.date desc, pu.created_at desc`,
      params
    );
    res.json(await attachLines(rows));
  } catch (err) { next(err); }
});

const lineSchema = z.object({
  productId: z.string().uuid().optional(),
  newProduct: z.object({
    name: z.string().min(1),
    sellPrice: z.number().min(0).optional(),
    minStock: z.number().min(0).default(0),
    unit: z.string().min(1).default('pcs'),
  }).optional(),
  qty: z.number().positive(),
  unitPrice: z.number().min(0),
}).refine((l) => l.productId || l.newProduct, { message: 'Provide either productId or newProduct' });

const purchaseSchema = z.object({
  invoiceNumber: z.string().optional(),
  pragyapanNumber: z.string().optional(),
  supplierId: z.string().uuid(),
  lines: z.array(lineSchema).min(1, 'Add at least one product.'),
  paidAmount: z.number().min(0).default(0),
  accountId: z.string().uuid().optional(),
}).refine((b) => b.paidAmount <= 0 || !!b.accountId, { message: 'Choose which account the payment went from.' });

async function heading(client, companyId, h) {
  const { rows } = await client.query('select id from accounts where company_id=$1 and heading=$2 limit 1', [companyId, h]);
  if (!rows[0]) { const e = new Error(`Missing required account for heading "${h}"`); e.status = 500; throw e; }
  return rows[0].id;
}

async function createPurchaseWithinTx(client, companyId, userId, body) {
  const supRes = await client.query('select * from suppliers where id=$1 and company_id=$2', [body.supplierId, companyId]);
  const supplier = supRes.rows[0];
  if (!supplier) { const e = new Error('Supplier not found'); e.status = 404; throw e; }

  let subtotal = 0;
  const lineData = [];
  for (const line of body.lines) {
    let product;
    if (line.newProduct) {
      const { rows } = await client.query(
        `insert into products (company_id, name, purchase_price, sell_price, stock, min_stock, unit)
         values ($1,$2,$3,$4,0,$5,$6) returning *`,
        [companyId, line.newProduct.name, line.unitPrice, line.newProduct.sellPrice ?? line.unitPrice, line.newProduct.minStock, line.newProduct.unit]
      );
      product = rows[0];
    } else {
      const { rows } = await client.query('select * from products where id=$1 and company_id=$2 for update', [line.productId, companyId]);
      product = rows[0];
      if (!product) { const e = new Error('Product not found'); e.status = 404; throw e; }
      await client.query('update products set purchase_price=$1 where id=$2', [line.unitPrice, product.id]);
    }
    const lineTotal = line.unitPrice * line.qty;
    subtotal += lineTotal;
    lineData.push({ product, qty: line.qty, unitPrice: line.unitPrice, unit: product.unit, lineTotal });
  }
  const total = Math.round(subtotal * 100) / 100;

  for (const l of lineData) {
    await client.query('update products set stock = stock + $1 where id = $2', [l.qty, l.product.id]);
  }

  const date = await companyToday(client, companyId);
  const invAcct = await heading(client, companyId, 'Inventory');
  const invoiceRef = (body.invoiceNumber ? ' — Invoice ' + body.invoiceNumber : '') + (body.pragyapanNumber ? ' — PP ' + body.pragyapanNumber : '');

  const lines = [{ accountId: invAcct, debit: total, credit: 0 }, { accountId: supplier.account_id, debit: 0, credit: total }];
  const entry = await postJournal(client, { companyId, date, memo: `Purchase from ${supplier.name}${invoiceRef}`, source: 'Purchase', reference: body.invoiceNumber, lines, createdBy: userId });

  const { rows } = await client.query(
    `insert into purchase_invoices
       (company_id, invoice_number, pragyapan_number, supplier_id, subtotal, total, paid_amount, credit_amount, payment_account_id, journal_entry_id, date, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [companyId, body.invoiceNumber || null, body.pragyapanNumber || null, body.supplierId, subtotal, total, 0, total, body.accountId || null, entry?.id || null, date, userId]
  );
  const purchase = rows[0];

  for (const l of lineData) {
    await client.query(
      `insert into purchase_invoice_lines (purchase_invoice_id, product_id, unit, qty, unit_price, line_total) values ($1,$2,$3,$4,$5,$6)`,
      [purchase.id, l.product.id, l.unit, l.qty, l.unitPrice, l.lineTotal]
    );
  }

  // Same principle as Sales: the invoice always posts its full amount to
  // Accounts Payable; any amount paid up front is a separate, visible
  // payment transaction against this specific bill.
  if (body.paidAmount > 0) {
    const applied = Math.min(body.paidAmount, total);
    await createPaymentWithinTx(client, companyId, userId, {
      type: 'supplier_payment', partyId: body.supplierId, amount: applied, accountId: body.accountId,
      date, invoiceNumber: body.invoiceNumber, purchaseInvoiceId: purchase.id,
    });
    purchase.paid_amount = applied;
    purchase.credit_amount = Math.round((total - applied) * 100) / 100;
    await client.query('update purchase_invoices set paid_amount=$1, credit_amount=$2 where id=$3', [purchase.paid_amount, purchase.credit_amount, purchase.id]);
  }

  purchase.lines = lineData.map((l) => ({ product_name: l.product.name, unit: l.unit, qty: l.qty, unit_price: l.unitPrice, line_total: l.lineTotal }));
  return purchase;
}

async function reversePurchaseWithinTx(client, companyId, purchaseId) {
  const { rows } = await client.query('select * from purchase_invoices where id=$1 and company_id=$2', [purchaseId, companyId]);
  const purchase = rows[0];
  if (!purchase) return null;
  const { rows: lines } = await client.query('select * from purchase_invoice_lines where purchase_invoice_id=$1', [purchaseId]);
  for (const l of lines) {
    await client.query('update products set stock = stock - $1 where id = $2', [l.qty, l.product_id]);
  }
  await reverseLinkedPaymentsWithinTx(client, companyId, { purchaseInvoiceId: purchaseId });
  await reverseJournalEntry(client, purchase.journal_entry_id);
  await client.query('delete from purchase_invoices where id = $1', [purchaseId]); // cascades to purchase_invoice_lines
  return purchase;
}

router.post('/', requireRole('manager'), async (req, res, next) => {
  try {
    const body = purchaseSchema.parse(req.body);
    const purchase = await withTransaction(async (client) => {
      const p = await createPurchaseWithinTx(client, req.user.company_id, req.user.id, body);
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'create', entity: 'purchase_invoice', entityId: p.id, details: { invoiceNumber: p.invoice_number, pragyapanNumber: p.pragyapan_number, total: p.total } });
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
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'update', entity: 'purchase_invoice', entityId: p.id, details: { replaced: old.id, before: { invoiceNumber: old.invoice_number, total: old.total }, after: { invoiceNumber: p.invoice_number, total: p.total } } });
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
      if (old) await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'delete', entity: 'purchase_invoice', entityId: old.id, details: { invoiceNumber: old.invoice_number, total: old.total } });
      return old;
    });
    if (!purchase) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
