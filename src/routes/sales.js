const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { postJournal, reverseJournalEntry } = require('../services/ledger');
const { createPaymentWithinTx, reverseLinkedPaymentsWithinTx } = require('../services/payments');
const { companyToday } = require('../services/dates');
const { audit } = require('../services/audit');
const { buildSalesInvoicePdf } = require('../services/invoicePdf');
const { resolveUnitFactor } = require('../services/uom');

const router = express.Router();

async function attachLines(invoices) {
  if (!invoices.length) return invoices;
  const { rows: lines } = await pool.query(
    `select sl.*, p.name as product_name from sales_invoice_lines sl join products p on p.id = sl.product_id
     where sl.sales_invoice_id = any($1::uuid[]) order by sl.id`,
    [invoices.map((i) => i.id)]
  );
  const byInvoice = {};
  for (const l of lines) (byInvoice[l.sales_invoice_id] ||= []).push(l);
  return invoices.map((i) => ({ ...i, lines: byInvoice[i.id] || [] }));
}

// GET /api/sales?q=search&from=YYYY-MM-DD&till=YYYY-MM-DD&type=cash|credit|all
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const from = (req.query.from || '').trim();
    const till = (req.query.till || '').trim();
    const type = (req.query.type || '').trim(); // 'cash' | 'credit' | ''
    const params = [req.user.company_id];
    let where = 'where s.company_id = $1';
    if (q) {
      params.push(`%${q}%`);
      where += ` and (s.invoice_number ilike $${params.length} or c.name ilike $${params.length} or exists (
        select 1 from sales_invoice_lines sl join products p on p.id = sl.product_id
        where sl.sales_invoice_id = s.id and p.name ilike $${params.length}
      ))`;
    }
    if (from) { params.push(from); where += ` and s.date >= $${params.length}`; }
    if (till) { params.push(till); where += ` and s.date <= $${params.length}`; }
    if (type === 'cash') where += ` and s.cash_sale = true`;
    else if (type === 'credit') where += ` and s.cash_sale = false`;

    const { rows } = await pool.query(
      `select s.*, c.name as customer_name, a.name as account_name
       from sales_invoices s
       join customers c on c.id = s.customer_id
       left join accounts a on a.id = s.payment_account_id
       ${where}
       order by s.date desc, s.created_at desc`,
      params
    );
    const invoices = await attachLines(rows);

    // Summary totals over the filtered result set
    const summary = invoices.reduce(
      (acc, s) => {
        acc.total += Number(s.total);
        if (s.cash_sale) acc.cashTotal += Number(s.total);
        else { acc.creditTotal += Number(s.total); acc.creditOutstanding += Number(s.credit_amount); }
        return acc;
      },
      { total: 0, cashTotal: 0, creditTotal: 0, creditOutstanding: 0 }
    );

    res.json({ invoices, summary });
  } catch (err) { next(err); }
});

// GET /api/sales/:id/pdf — printable invoice
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    const { rows } = await pool.query(
      `select s.*, c.name as customer_name, c.contact as customer_contact,
              a.name as account_name, co.name as company_name, co.currency
       from sales_invoices s
       join customers c on c.id = s.customer_id
       join companies co on co.id = s.company_id
       left join accounts a on a.id = s.payment_account_id
       where s.id = $1 and s.company_id = $2`,
      [req.params.id, companyId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Not found' });
    const { rows: lines } = await pool.query(
      `select sl.*, p.name as product_name from sales_invoice_lines sl join products p on p.id = sl.product_id
       where sl.sales_invoice_id = $1 order by sl.id`,
      [req.params.id]
    );

    const pdf = await buildSalesInvoicePdf({
      company: { name: r.company_name, currency: r.currency },
      sale: r,
      customer: { name: r.customer_name, contact: r.customer_contact },
      lines: lines.map((l) => ({ name: l.product_name, unit: l.unit, qty: l.qty, price: l.price, lineTotal: l.line_total })),
      paymentAccount: r.account_name ? { name: r.account_name } : null,
    });

    const safeName = String(r.invoice_number || r.id).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${safeName}.pdf"`);
    res.send(pdf);
  } catch (err) { next(err); }
});

const lineSchema = z.object({ productId: z.string().uuid(), qty: z.number().positive(), price: z.number().min(0), unit: z.string().min(1) });
const saleSchema = z.object({
  invoiceNumber: z.string().optional(),
  customerId: z.string().uuid(),
  lines: z.array(lineSchema).min(1, 'Add at least one product.'),
  discount: z.number().min(0).default(0),
  cashSale: z.boolean().default(false),
  paidAmount: z.number().min(0).default(0),
  accountId: z.string().uuid().optional(),
}).refine((b) => b.cashSale || b.paidAmount <= 0 || !!b.accountId, { message: 'Choose which account the payment went into.' })
  .refine((b) => !b.cashSale || !!b.accountId, { message: 'Choose which account the cash sale went into.' });

// Looks up the ORIGINAL system account for a heading (Sales, Cost of Goods
// Sold, Inventory, Discount Allowed) — never a custom account someone added
// under the same heading later. Multiple accounts can share a heading (e.g.
// several Bank accounts), so without the is_system filter this could pick
// any of them, including one that has nothing to do with automatic postings.
async function heading(client, companyId, h) {
  const { rows } = await client.query(
    'select id from accounts where company_id=$1 and heading=$2 and is_system=true order by created_at asc limit 1',
    [companyId, h]
  );
  if (!rows[0]) { const e = new Error(`Missing required system account for heading "${h}"`); e.status = 500; throw e; }
  return rows[0].id;
}

async function createSaleWithinTx(client, companyId, userId, body) {
  const custRes = await client.query('select * from customers where id=$1 and company_id=$2', [body.customerId, companyId]);
  const customer = custRes.rows[0];
  if (!customer) { const e = new Error('Customer not found'); e.status = 404; throw e; }

  let subtotal = 0, totalCost = 0;
  const lineData = [];
  for (const line of body.lines) {
    const prodRes = await client.query('select * from products where id=$1 and company_id=$2 for update', [line.productId, companyId]);
    const product = prodRes.rows[0];
    if (!product) { const e = new Error('Product not found'); e.status = 404; throw e; }

    // Stock is always tracked in the product's BASE unit — convert whatever
    // unit this line was sold in before touching stock or costing it.
    const conversionFactor = resolveUnitFactor(product, line.unit);
    if (conversionFactor === null) {
      const e = new Error(`"${line.unit}" is not a valid unit for "${product.name}" (base: ${product.unit}${product.alt_unit ? `, alternate: ${product.alt_unit}` : ''}).`);
      e.status = 400; throw e;
    }
    const baseQty = Math.round(line.qty * conversionFactor * 10000) / 10000;

    if (Number(product.stock) < baseQty) {
      const e = new Error(`Insufficient stock: only ${product.stock} ${product.unit} of "${product.name}" available (you're selling ${line.qty} ${line.unit} = ${baseQty} ${product.unit}).`);
      e.status = 400; throw e;
    }
    const lineTotal = line.price * line.qty;
    const lineCost = Number(product.purchase_price) * baseQty; // cost normalized to base UOM
    subtotal += lineTotal;
    totalCost += lineCost;
    lineData.push({ product, qty: line.qty, price: line.price, unit: line.unit, baseQty, conversionFactor, lineTotal, lineCost });
  }

  const discount = Math.min(Math.max(body.discount || 0, 0), subtotal);
  const total = Math.round((subtotal - discount) * 100) / 100;

  for (const l of lineData) {
    await client.query('update products set stock = stock - $1 where id = $2', [l.baseQty, l.product.id]);
  }

  const date = await companyToday(client, companyId);
  const salesAcct = await heading(client, companyId, 'Sales');
  const invoiceRef = body.invoiceNumber ? ' — Invoice ' + body.invoiceNumber : '';

  let paidAmount, creditAmount, invoiceJournalId;

  if (body.cashSale) {
    paidAmount = total; creditAmount = 0;
    const lines = [{ accountId: body.accountId, debit: total, credit: 0 }, { accountId: salesAcct, debit: 0, credit: subtotal }];
    if (discount > 0) lines.push({ accountId: await heading(client, companyId, 'Discount Allowed'), debit: discount, credit: 0 });
    if (totalCost > 0) {
      lines.push({ accountId: await heading(client, companyId, 'Cost of Goods Sold'), debit: totalCost, credit: 0 });
      lines.push({ accountId: await heading(client, companyId, 'Inventory'), debit: 0, credit: totalCost });
    }
    const entry = await postJournal(client, { companyId, date, memo: `Cash sale to ${customer.name}${invoiceRef}`, source: 'Sale', reference: body.invoiceNumber, lines, createdBy: userId });
    invoiceJournalId = entry?.id || null;
  } else {
    paidAmount = 0; creditAmount = total; // may be reduced just below if an upfront payment is recorded
    const lines = [{ accountId: customer.account_id, debit: total, credit: 0 }, { accountId: salesAcct, debit: 0, credit: subtotal }];
    if (discount > 0) lines.push({ accountId: await heading(client, companyId, 'Discount Allowed'), debit: discount, credit: 0 });
    if (totalCost > 0) {
      lines.push({ accountId: await heading(client, companyId, 'Cost of Goods Sold'), debit: totalCost, credit: 0 });
      lines.push({ accountId: await heading(client, companyId, 'Inventory'), debit: 0, credit: totalCost });
    }
    const entry = await postJournal(client, { companyId, date, memo: `Sale to ${customer.name}${invoiceRef}`, source: 'Sale', reference: body.invoiceNumber, lines, createdBy: userId });
    invoiceJournalId = entry?.id || null;
  }

  const { rows } = await client.query(
    `insert into sales_invoices
       (company_id, invoice_number, customer_id, subtotal, discount, total, paid_amount, credit_amount, payment_account_id, journal_entry_id, date, cash_sale, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [companyId, body.invoiceNumber || null, body.customerId, subtotal, discount, total, paidAmount, creditAmount, body.accountId || null, invoiceJournalId, date, body.cashSale, userId]
  );
  const sale = rows[0];

  for (const l of lineData) {
    await client.query(
      `insert into sales_invoice_lines (sales_invoice_id, product_id, unit, qty, price, cost, line_total, base_qty, conversion_factor)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [sale.id, l.product.id, l.unit, l.qty, l.price, l.lineCost, l.lineTotal, l.baseQty, l.conversionFactor]
    );
  }

  // An upfront payment on a credit sale is its own, separately visible
  // transaction against this invoice — not folded into the invoice's own
  // journal entry — so the ledger shows the real invoice and the real
  // payment against it, not a pre-netted figure.
  if (!body.cashSale && body.paidAmount > 0) {
    const applied = Math.min(body.paidAmount, total);
    await createPaymentWithinTx(client, companyId, userId, {
      type: 'customer_receipt', partyId: body.customerId, amount: applied, accountId: body.accountId,
      date, invoiceNumber: body.invoiceNumber, salesInvoiceId: sale.id,
    });
    sale.paid_amount = applied;
    sale.credit_amount = Math.round((total - applied) * 100) / 100;
    await client.query('update sales_invoices set paid_amount=$1, credit_amount=$2 where id=$3', [sale.paid_amount, sale.credit_amount, sale.id]);
  }

  sale.lines = lineData.map((l) => ({ product_name: l.product.name, unit: l.unit, qty: l.qty, price: l.price, line_total: l.lineTotal, base_qty: l.baseQty }));
  return sale;
}

async function reverseSaleWithinTx(client, companyId, saleId) {
  const { rows } = await client.query('select * from sales_invoices where id=$1 and company_id=$2', [saleId, companyId]);
  const sale = rows[0];
  if (!sale) return null;
  const { rows: lines } = await client.query('select * from sales_invoice_lines where sales_invoice_id=$1', [saleId]);
  for (const l of lines) {
    // Restore using base_qty (the actual amount deducted at sale time), NOT
    // qty (the quantity in whatever unit it was sold in) — those differ
    // whenever the sale used the alternate unit, and using qty here would
    // silently corrupt the stock count.
    await client.query('update products set stock = stock + $1 where id = $2', [l.base_qty, l.product_id]);
  }
  await reverseLinkedPaymentsWithinTx(client, companyId, { salesInvoiceId: saleId });
  await reverseJournalEntry(client, sale.journal_entry_id);
  await client.query('delete from sales_invoices where id = $1', [saleId]); // cascades to sales_invoice_lines
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

router.put('/:id', requireRole('manager'), async (req, res, next) => {
  try {
    const body = saleSchema.parse(req.body);
    const sale = await withTransaction(async (client) => {
      const old = await reverseSaleWithinTx(client, req.user.company_id, req.params.id);
      if (!old) { const e = new Error('Not found'); e.status = 404; throw e; }
      const s = await createSaleWithinTx(client, req.user.company_id, req.user.id, body);
      await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'update', entity: 'sales_invoice', entityId: s.id, details: { replaced: old.id, before: { invoiceNumber: old.invoice_number, total: old.total }, after: { invoiceNumber: s.invoice_number, total: s.total } } });
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
      if (old) await audit(client, { companyId: req.user.company_id, userId: req.user.id, action: 'delete', entity: 'sales_invoice', entityId: old.id, details: { invoiceNumber: old.invoice_number, total: old.total } });
      return old;
    });
    if (!sale) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
