// Run with: node test/uom.test.js
// Pure math — no database, no network — covering the multi-unit conversion
// logic that stock deduction and COGS both depend on. A mistake here would
// silently corrupt inventory counts, so this is worth keeping green.

const { standardFactor, resolveUnitFactor } = require('../src/services/uom');

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, detail ?? ''); } }

check('MTR base, YRD alt -> 0.9144', standardFactor('MTR', 'YRD') === 0.9144);
check('YRD base, MTR alt -> 1.09361', standardFactor('YRD', 'MTR') === 1.09361);
check('unrelated units -> null (no bogus default)', standardFactor('KG', 'LTR') === null);

const fabricMtr = { unit: 'MTR', alt_unit: 'YRD', alt_unit_factor: 0.9144 };
check('selecting base unit -> factor 1', resolveUnitFactor(fabricMtr, 'MTR') === 1);
check('selecting configured alt unit -> product factor', resolveUnitFactor(fabricMtr, 'YRD') === 0.9144);
check('selecting an unconfigured unit -> null (rejected)', resolveUnitFactor(fabricMtr, 'KG') === null);

const noAlt = { unit: 'pcs', alt_unit: null, alt_unit_factor: null };
check('product with no alt unit: base still resolves', resolveUnitFactor(noAlt, 'pcs') === 1);
check('product with no alt unit: anything else rejected', resolveUnitFactor(noAlt, 'YRD') === null);

function deduct(qtySoldInChosenUnit, factor) { return qtySoldInChosenUnit * factor; }

const deductedMeters = deduct(10, resolveUnitFactor(fabricMtr, 'YRD'));
check('10 YRD sold, base=MTR -> deducts 9.144 MTR from stock', Math.abs(deductedMeters - 9.144) < 1e-9, deductedMeters);

const fabricYrd = { unit: 'YRD', alt_unit: 'MTR', alt_unit_factor: 1.09361 };
const deductedYards = deduct(10, resolveUnitFactor(fabricYrd, 'MTR'));
check('10 MTR sold, base=YRD -> deducts 10.9361 YRD from stock', Math.abs(deductedYards - 10.9361) < 1e-9, deductedYards);

let stock = 500;
stock -= deduct(10, resolveUnitFactor(fabricMtr, 'YRD'));
stock += deduct(10, resolveUnitFactor(fabricMtr, 'YRD')); // reversal uses the SAME stored factor/qty
check('deduct then restore returns to exact original stock', stock === 500, stock);

function cogsForLine(product, qtySoldInChosenUnit, chosenUnit) {
  const factor = resolveUnitFactor(product, chosenUnit);
  const baseQty = qtySoldInChosenUnit * factor;
  return baseQty * product.purchase_price;
}
const fabricWithCost = { ...fabricMtr, purchase_price: 80 };
check('COGS for 10 YRD sold (base MTR, cost/MTR=80) = 9.144 * 80', Math.abs(cogsForLine(fabricWithCost, 10, 'YRD') - 731.52) < 1e-9);
check('COGS for 10 MTR sold (selling in base unit) = 10 * 80 exactly', cogsForLine(fabricWithCost, 10, 'MTR') === 800);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
