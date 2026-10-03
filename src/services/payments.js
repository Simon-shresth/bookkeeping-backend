const { postJournal, reverseJournalEntry } = require('./ledger');

// Posts a payment and its journal entry. `salesInvoiceId`/`purchaseInvoiceId`
// are optional — when set, this payment is shown against that specific
// invoice in the General Ledger (date/memo/reference included) instead of
// as a generic, unattributed credit against the customer/supplier.
async function createPaymentWithinTx(client, companyId, userId, body) {
  const acct = await client.query(
    "select id from accounts where id=$1 and company_id=$2 and heading in ('Cash','Bank')",
    [body.accountId, companyId]
  );
  if (!acct.rows[0]) { const e = new Error('Choose a Cash or Bank account.'); e.status = 400; throw e; }

  const isReceipt = body.type === 'customer_receipt';
  const party = await client.query(
    `select id, name, account_id from ${isReceipt ? 'customers' : 'suppliers'} where id=$1 and company_id=$2`,
    [body.partyId, companyId]
  );
  if (!party.rows[0]) { const e = new Error(isReceipt ? 'Customer not found' : 'Supplier not found'); e.status = 404; throw e; }

  const date = body.date;
  const lines = isReceipt
    ? [{ accountId: body.accountId, debit: body.amount, credit: 0 }, { accountId: party.rows[0].account_id, debit: 0, credit: body.amount }]
    : [{ accountId: party.rows[0].account_id, debit: body.amount, credit: 0 }, { accountId: body.accountId, debit: 0, credit: body.amount }];
  const invoiceRef = body.invoiceNumber ? ` — Invoice ${body.invoiceNumber}` : '';
  const memo = (isReceipt ? `Payment received from ${party.rows[0].name}` : `Payment to ${party.rows[0].name}`) + invoiceRef;

  const entry = await postJournal(client, { companyId, date, memo, source: 'Payment', reference: body.reference || body.invoiceNumber, lines, createdBy: userId });

  const { rows } = await client.query(
    `insert into payments (company_id, type, customer_id, supplier_id, amount, account_id, journal_entry_id, date, created_by, reference, sales_invoice_id, purchase_invoice_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [
      companyId, body.type, isReceipt ? body.partyId : null, isReceipt ? null : body.partyId,
      body.amount, body.accountId, entry?.id || null, date, userId, body.reference || null,
      body.salesInvoiceId || null, body.purchaseInvoiceId || null,
    ]
  );
  return rows[0];
}

async function reversePaymentWithinTx(client, companyId, paymentId) {
  const { rows } = await client.query('select * from payments where id=$1 and company_id=$2', [paymentId, companyId]);
  const payment = rows[0];
  if (!payment) return null;
  await reverseJournalEntry(client, payment.journal_entry_id);
  await client.query('delete from payments where id = $1', [paymentId]);
  return payment;
}

// Reverses every payment linked to a given invoice (called when that
// invoice itself is edited or deleted).
async function reverseLinkedPaymentsWithinTx(client, companyId, { salesInvoiceId, purchaseInvoiceId }) {
  const column = salesInvoiceId ? 'sales_invoice_id' : 'purchase_invoice_id';
  const value = salesInvoiceId || purchaseInvoiceId;
  const { rows } = await client.query(`select id from payments where ${column} = $1 and company_id = $2`, [value, companyId]);
  for (const row of rows) {
    await reversePaymentWithinTx(client, companyId, row.id);
  }
}

module.exports = { createPaymentWithinTx, reversePaymentWithinTx, reverseLinkedPaymentsWithinTx };
