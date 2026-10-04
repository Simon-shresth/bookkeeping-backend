-- Multi-unit inventory conversion: a product's stock is always tracked in
-- its Base UOM (the existing `unit` column), with an optional second
-- "alternate unit" it can also be sold in (e.g. a fabric stocked in Meters
-- but sometimes sold in Yards). `alt_unit_factor` is how many base units
-- one alternate unit equals (e.g. base=MTR, alt=YRD -> 0.9144).

alter table products
  add column if not exists alt_unit text,
  add column if not exists alt_unit_factor numeric(14,6);

-- Widen stock precision: converted quantities (e.g. 10 yards -> 9.144
-- meters) need more than 2 decimal places to avoid silent rounding drift
-- on every sale.
alter table products alter column stock type numeric(14,4);
alter table products alter column min_stock type numeric(14,4);

-- Each sale line now snapshots the unit it was actually transacted in, the
-- conversion factor used (so a later change to the product's factor never
-- rewrites history), and the resulting base-UOM quantity that was actually
-- deducted from stock and used for COGS.
alter table sales_invoice_lines
  add column if not exists base_qty numeric(14,4),
  add column if not exists conversion_factor numeric(14,6) not null default 1;

update sales_invoice_lines set base_qty = qty where base_qty is null;
alter table sales_invoice_lines alter column base_qty set not null;
alter table sales_invoice_lines alter column qty type numeric(14,4);
