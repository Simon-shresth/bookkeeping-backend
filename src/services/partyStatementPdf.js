const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { formatNepaliNumber } = require('./numberFormat');

const INK = rgb(0.118, 0.169, 0.137);
const MUTED = rgb(0.36, 0.4, 0.376);
const RULE = rgb(0.85, 0.82, 0.76);
const ACCENT = rgb(0.118, 0.169, 0.137);

function money(n, currency) {
  const symbol = currency === 'NPR' || !currency ? 'Rs.' : currency;
  return `${symbol} ${formatNepaliNumber(n)}`;
}

function makeSafe(font) {
  return (text) => {
    let out = '';
    for (const ch of String(text ?? '')) {
      try { font.encodeText(ch); out += ch; } catch { out += '?'; }
    }
    return out;
  };
}

// Builds a one-page-per-party-group outstanding balances statement.
// parties: [{ name, contact, outstanding }]
// kind: 'Accounts Receivable' | 'Accounts Payable'
async function buildPartyStatementPdf({ company, parties, kind }) {
  const pdf = await PDFDocument.create();
  let page = pdf.addPage([595.28, 841.89]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safeR = makeSafe(regular);
  const safeB = makeSafe(bold);
  const { width } = page.getSize();
  const left = 50;
  const right = width - 50;
  const bottomMargin = 60;
  let y = 790;

  const text = (t, x, yy, { size = 10, font = regular, color = INK, align = 'left' } = {}) => {
    const s = (font === bold ? safeB : safeR)(t);
    const w = font.widthOfTextAtSize(s, size);
    page.drawText(s, { x: align === 'right' ? x - w : x, y: yy, size, font, color });
  };
  const rule = (yy, thickness = 0.7) =>
    page.drawLine({ start: { x: left, y: yy }, end: { x: right, y: yy }, thickness, color: RULE });

  const newPage = () => {
    page = pdf.addPage([595.28, 841.89]);
    y = 790;
    drawTableHeader();
  };
  const ensureSpace = (needed) => { if (y - needed < bottomMargin) newPage(); };

  // Column layout
  const colName = left;
  const colContact = left + 220;
  const colBalance = right;

  const drawTableHeader = () => {
    text('NAME', colName, y, { size: 8, color: MUTED });
    text('CONTACT', colContact, y, { size: 8, color: MUTED });
    text('OUTSTANDING', colBalance, y, { size: 8, color: MUTED, align: 'right' });
    y -= 8;
    rule(y);
    y -= 16;
  };

  // ── Header ─────────────────────────────────────────────────────────────────
  text(company.name, left, y, { size: 18, font: bold });
  text(kind.toUpperCase() + ' STATEMENT', right, y, { size: 14, font: bold, align: 'right' });
  y -= 22;
  const today = new Date().toISOString().slice(0, 10);
  text(`As at ${today}`, right, y, { align: 'right', color: MUTED });
  y -= 30;
  rule(y, 1);
  y -= 24;

  drawTableHeader();

  // ── Rows ──────────────────────────────────────────────────────────────────
  let grandTotal = 0;
  for (const p of parties) {
    ensureSpace(18);
    text(String(p.name), colName, y, { size: 9 });
    text(String(p.contact || '—'), colContact, y, { size: 9, color: MUTED });
    text(money(p.outstanding, company.currency), colBalance, y, { size: 9, align: 'right' });
    grandTotal += Number(p.outstanding) || 0;
    y -= 16;
    y -= 2;
  }

  // ── Total ─────────────────────────────────────────────────────────────────
  ensureSpace(24);
  rule(y);
  y -= 16;
  text('Total Outstanding', left, y, { font: bold });
  text(money(grandTotal, company.currency), colBalance, y, { font: bold, align: 'right' });

  return Buffer.from(await pdf.save());
}

module.exports = { buildPartyStatementPdf };
