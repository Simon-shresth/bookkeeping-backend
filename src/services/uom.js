// Unit-of-measurement conversion. A product's stock is always tracked in
// its base unit (products.unit); an optional alternate unit
// (products.alt_unit / alt_unit_factor) lets it also be sold in a second
// unit, converted automatically.

// Industry-standard factors offered as a default when a product's base/alt
// pair is exactly Meters<->Yards — never silently assumed for any other
// pair, since units like that don't have one universal conversion.
function standardFactor(baseUnit, altUnit) {
  if (baseUnit === 'MTR' && altUnit === 'YRD') return 0.9144;   // 1 yard = 0.9144 meters
  if (baseUnit === 'YRD' && altUnit === 'MTR') return 1.09361;  // 1 meter = 1.09361 yards
  return null;
}

// How many base units one unit of `chosenUnit` represents for this product.
// Returns null if chosenUnit isn't valid for this product at all (neither
// its base unit nor its configured alternate unit).
function resolveUnitFactor(product, chosenUnit) {
  if (chosenUnit === product.unit) return 1;
  if (product.alt_unit && chosenUnit === product.alt_unit) return Number(product.alt_unit_factor);
  return null;
}

module.exports = { standardFactor, resolveUnitFactor };
