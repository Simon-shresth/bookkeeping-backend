const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const INK = rgb(0.118, 0.169, 0.137);
const MUTED = rgb(0.36, 0.4, 0.376);
const RULE = rgb(0.85, 0.82, 0.76);

function money(n, currency) {
  const symbol = currency === 'NPR' || !currency ? 'Rs.' : currency;
  return `${symbol} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The built-in PDF fonts only cover Latin (WinAnsi) characters. Anything
// outside that range (e.g. Devanagari in a customer name) is replaced with
// "?" rather than crashing the download. Embedding a Unicode font via
// @pdf-lib/fontkit is the upgrade path if non-Latin names are needed.
function makeSafe(font) {
  return (text) => {
    let out = '';
    for (const ch of String(text ?? '')) {
      try { font.encodeText(ch); out += ch; } catch { out += '?'; }
    }
    return out;
  };
}

// invoice: { company:{name,currency}, sale, customer, product, paymentAccount }
async function buildSalesInvoicePdf({ company, sale, customer, product, paymentAccount }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safeR = makeSafe(regular);
  const safeB = makeSafe(bold);
  const { width } = page.getSize();
  const left = 50;
  const right = width - 50;
  let y = 790;

  const text = (t, x, yy, { size = 10, font = regular, color = INK, align = 'left' } = {}) => {
    const s = (font === bold ? safeB : safeR)(t);
    const w = font.widthOfTextAtSize(s, size);
    page.drawText(s, { x: align === 'right' ? x - w : x, y: yy, size, font, color });
  };
  const rule = (yy) => page.drawLine({ start: { x: left, y: yy }, end: { x: right, y: yy }, thickness: 0.7, color: RULE });

  // Header
  text(company.name, left, y, { size: 18, font: bold });
  text('INVOICE', right, y, { size: 18, font: bold, align: 'right' });
  y -= 22;
  text(`Invoice No: ${sale.invoice_number || '—'}`, right, y, { align: 'right' });
  y -= 14;
  text(`Date: ${String(sale.date).slice(0, 10)}`, right, y, { align: 'right' });
  y -= 30;
  rule(y);
  y -= 24;

  // Bill to
  text('BILL TO', left, y, { size: 8, color: MUTED });
  y -= 15;
  text(customer.name, left, y, { size: 12, font: bold });
  if (customer.contact) { y -= 14; text(customer.contact, left, y, { color: MUTED }); }
  y -= 34;

  // Line items table
  const colQty = 340, colPrice = 430, colAmount = right;
  text('DESCRIPTION', left, y, { size: 8, color: MUTED });
  text('QTY', colQty, y, { size: 8, color: MUTED, align: 'right' });
  text('UNIT PRICE', colPrice, y, { size: 8, color: MUTED, align: 'right' });
  text('AMOUNT', colAmount, y, { size: 8, color: MUTED, align: 'right' });
  y -= 8;
  rule(y);
  y -= 18;
  text(product.name, left, y);
  text(String(Number(sale.qty)), colQty, y, { align: 'right' });
  text(money(sale.price, company.currency), colPrice, y, { align: 'right' });
  text(money(sale.total, company.currency), colAmount, y, { align: 'right' });
  y -= 14;
  rule(y);
  y -= 26;

  // Totals
  const labelX = 400;
  text('Total', labelX, y, { font: bold });
  text(money(sale.total, company.currency), colAmount, y, { font: bold, align: 'right' });
  y -= 16;
  text('Paid at invoicing', labelX, y, { color: MUTED });
  text(money(sale.paid_amount, company.currency), colAmount, y, { align: 'right' });
  if (paymentAccount && Number(sale.paid_amount) > 0) {
    y -= 12;
    text(`into ${paymentAccount.name}`, labelX, y, { size: 8, color: MUTED });
  }
  y -= 16;
  text('On credit', labelX, y, { font: bold });
  text(money(sale.credit_amount, company.currency), colAmount, y, { font: bold, align: 'right' });

  // Footer
  text('Thank you for your business.', left, 60, { size: 9, color: MUTED });
  text('Amounts shown are as at the time of invoicing; later payments are recorded separately.', left, 46, { size: 8, color: MUTED });

  return Buffer.from(await pdf.save());
}

module.exports = { buildSalesInvoicePdf };
