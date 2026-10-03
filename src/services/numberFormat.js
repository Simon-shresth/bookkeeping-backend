// Nepali (lakh/crore) digit grouping, matching src/components/Money.jsx on
// the frontend: the last 3 digits as one group, then groups of 2 thereafter
// — e.g. 1234567.89 -> 12,34,567.89. Used anywhere the backend renders a
// number into text (PDFs), so printed documents match what's shown on screen.
function formatNepaliNumber(value, decimals = 2) {
  const num = Number(value || 0);
  const neg = num < 0;
  const fixed = Math.abs(num).toFixed(decimals);
  const [intPartRaw, decPart] = fixed.split('.');
  let result = intPartRaw;
  if (intPartRaw.length > 3) {
    const last3 = intPartRaw.slice(-3);
    let rest = intPartRaw.slice(0, -3);
    const groups = [];
    while (rest.length > 2) { groups.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
    if (rest.length) groups.unshift(rest);
    result = groups.join(',') + ',' + last3;
  }
  return (neg ? '-' : '') + result + (decimals > 0 ? '.' + decPart : '');
}

module.exports = { formatNepaliNumber };
