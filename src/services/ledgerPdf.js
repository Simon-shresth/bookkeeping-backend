const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { formatNepaliNumber } = require('./numberFormat');

const INK = rgb(0.118, 0.169, 0.137);
const MUTED = rgb(0.36, 0.4, 0.376);
const RULE = rgb(0.85, 0.82, 0.76);

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

// ledger: { company:{name,currency}, account:{name}, openingBalance, closingBalance, entries:[...], from, till }
async function buildLedgerPdf({ company, account, openingBalance, closingBalance, entries, from, till }) {
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
  const rule = (yy) => page.drawLine({ start: { x: left, y: yy }, end: { x: right, y: yy }, thickness: 0.7, color: RULE });

  // Column positions sized from measured text widths (not guessed): each
  // amount column gets 78pt (room for 8-digit balances like Rs. 1,00,00,000.00
  // at 9pt) with an 8pt gap between columns, built right-to-left from the
  // page's right margin so nothing can run into its neighbor.
  const colDate = left;
  const colBal = right;
  const colCredit = colBal - 78 - 8;
  const colDebit = colCredit - 78 - 8;
  const colMemo = left + 65;
  const memoMaxWidth = colDebit - 78 - 8 - colMemo;
  const drawTableHeader = () => {
    text('DATE', colDate, y, { size: 8, color: MUTED });
    text('MEMO / REFERENCE / SOURCE', colMemo, y, { size: 8, color: MUTED });
    text('DEBIT', colDebit, y, { size: 8, color: MUTED, align: 'right' });
    text('CREDIT', colCredit, y, { size: 8, color: MUTED, align: 'right' });
    text('BALANCE', colBal, y, { size: 8, color: MUTED, align: 'right' });
    y -= 8;
    rule(y);
    y -= 16;
  };
  const newPage = () => { page = pdf.addPage([595.28, 841.89]); y = 790; drawTableHeader(); };
  const ensureSpace = (needed) => { if (y - needed < bottomMargin) newPage(); };

  text(company.name, left, y, { size: 18, font: bold });
  text('GENERAL LEDGER', right, y, { size: 16, font: bold, align: 'right' });
  y -= 22;
  text(account.name, right, y, { size: 12, font: bold, align: 'right' });
  y -= 14;
  const period = from || till ? `${from || 'start'} to ${till || 'present'}` : 'All dates';
  text(period, right, y, { align: 'right', color: MUTED });
  y -= 30;
  rule(y);
  y -= 24;

  text('Opening Balance', left, y, { color: MUTED });
  text(money(openingBalance, company.currency), colBal, y, { align: 'right', color: MUTED });
  y -= 22;
  drawTableHeader();

  for (const e of entries) {
    ensureSpace(30);
    const memoText = (e.reference ? `${e.memo} (${e.reference})` : e.memo) + ` — ${e.source}`;
    // Wrap long memos across up to 2 lines rather than running past the amount columns.
    const words = memoText.split(' ');
    let line1 = '', line2 = '';
    for (const w of words) {
      const test = line1 ? line1 + ' ' + w : w;
      if (regular.widthOfTextAtSize(safeR(test), 9) <= memoMaxWidth) line1 = test;
      else line2 = line2 ? line2 + ' ' + w : w;
    }
    text(e.date, colDate, y, { size: 9 });
    text(line1, colMemo, y, { size: 9 });
    text(e.debit > 0 ? money(e.debit, company.currency) : '', colDebit, y, { size: 9, align: 'right' });
    text(e.credit > 0 ? money(e.credit, company.currency) : '', colCredit, y, { size: 9, align: 'right' });
    text(money(e.runningBalance, company.currency), colBal, y, { size: 9, align: 'right' });
    y -= 13;
    if (line2) { ensureSpace(14); text(line2, colMemo, y, { size: 9, color: MUTED }); y -= 13; }
    y -= 3;
  }

  ensureSpace(20);
  rule(y);
  y -= 16;
  text('Closing Balance', left, y, { font: bold });
  text(money(closingBalance, company.currency), colBal, y, { font: bold, align: 'right' });

  return Buffer.from(await pdf.save());
}

module.exports = { buildLedgerPdf };
