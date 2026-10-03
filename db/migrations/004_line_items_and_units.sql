-- Phase 5: multiple products per invoice, units of measurement, cash sale +
-- discount, and payments linked to a specific invoice (so the ledger can
-- show the real invoice and the real payment against it, not a collapsed
-- outstanding figure).
--
-- NOTE: this restructures sales_invoices and purchase_invoices from
-- "one product per invoice" into a header + line-items model. Any sales or
-- purchases already entered under the old structure cannot be carried
-- forward automatically (there's no reliable way to infer which arbitrary
-- combination of products should become one invoice) — back up your
-- database first if it has real entries you need to keep.

alter table products add column if not exists unit text not null default 'pcs';

-- ---------- Sales: header + line items ----------

create table if not exists sales_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  sales_invoice_id  uuid not null references sales_invoices(id) on delete cascade,
  product_id        uuid not null references products(id),
  unit              text not null,
  qty               numeric(14,2) not null,
  price             numeric(14,2) not null,   -- selling price per unit, this line
  cost              numeric(14,2) not null,   -- product's cost per unit x qty, for COGS
  line_total        numeric(14,2) not null
);
create index if not exists idx_sales_lines_invoice on sales_invoice_lines(sales_invoice_id);

alter table sales_invoices
  drop column if exists product_id,
  drop column if exists qty,
  drop column if exists price,
  drop column if exists cost,
  add column if not exists subtotal numeric(14,2),
  add column if not exists discount numeric(14,2) not null default 0,
  add column if not exists cash_sale boolean not null default false;

-- ---------- Purchases: header + line items ----------

create table if not exists purchase_invoice_lines (
  id                   uuid primary key default gen_random_uuid(),
  purchase_invoice_id  uuid not null references purchase_invoices(id) on delete cascade,
  product_id           uuid not null references products(id),
  unit                 text not null,
  qty                  numeric(14,2) not null,
  unit_price           numeric(14,2) not null,
  line_total           numeric(14,2) not null
);
create index if not exists idx_purchase_lines_invoice on purchase_invoice_lines(purchase_invoice_id);

alter table purchase_invoices
  drop column if exists product_id,
  drop column if exists qty,
  drop column if exists unit_price,
  add column if not exists subtotal numeric(14,2);

-- ---------- Payments: link to the specific invoice they're paying off ----------
-- (Still works for standalone payments with no linked invoice — those
-- columns are simply null — e.g. an advance payment collected before any
-- invoice exists.)

alter table payments
  add column if not exists sales_invoice_id uuid references sales_invoices(id) on delete set null,
  add column if not exists purchase_invoice_id uuid references purchase_invoices(id) on delete set null;
create index if not exists idx_payments_sales_invoice on payments(sales_invoice_id);
create index if not exists idx_payments_purchase_invoice on payments(purchase_invoice_id);

-- ---------- New "Discount Allowed" expense account ----------
-- Discounts post as a separate line (gross Sales revenue stays visible in
-- reports, with the discount shown as its own expense) rather than quietly
-- netted out of revenue.

insert into accounts (company_id, name, heading, category, is_system)
select c.id, 'Discount Allowed', 'Discount Allowed', 'Expenses', true
from companies c
where not exists (
  select 1 from accounts a where a.company_id = c.id and a.heading = 'Discount Allowed'
);

create or replace function seed_default_accounts(p_company_id uuid)
returns void as $$
begin
  insert into accounts (company_id, name, heading, category, is_system) values
    (p_company_id, 'Cash', 'Cash', 'Assets', true),
    (p_company_id, 'Bank', 'Bank', 'Assets', true),
    (p_company_id, 'Inventory', 'Inventory', 'Assets', true),
    (p_company_id, 'Fixed Assets', 'Fixed Assets', 'Assets', true),
    (p_company_id, 'Loans', 'Loans', 'Liabilities', true),
    (p_company_id, 'Taxes Payable', 'Taxes Payable', 'Liabilities', true),
    (p_company_id, 'Owner''s Capital', 'Owner''s Capital', 'Equity', true),
    (p_company_id, 'Owner''s Drawings', 'Owner''s Drawings', 'Equity', true),
    (p_company_id, 'Retained Earnings', 'Retained Earnings', 'Equity', true),
    (p_company_id, 'Sales', 'Sales', 'Income', true),
    (p_company_id, 'Service Income', 'Service Income', 'Income', true),
    (p_company_id, 'Other Income', 'Other Income', 'Income', true),
    (p_company_id, 'Rent', 'Rent', 'Expenses', true),
    (p_company_id, 'Salary', 'Salary', 'Expenses', true),
    (p_company_id, 'Electricity', 'Electricity', 'Expenses', true),
    (p_company_id, 'Freight', 'Freight', 'Expenses', true),
    (p_company_id, 'Office Expenses', 'Office Expenses', 'Expenses', true),
    (p_company_id, 'Discount Allowed', 'Discount Allowed', 'Expenses', true),
    (p_company_id, 'Cost of Goods Sold', 'Cost of Goods Sold', 'Expenses', true);
end;
$$ language plpgsql;
