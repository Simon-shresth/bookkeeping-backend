-- Migration 018: VAT support for sales and purchase invoices
-- Add VAT fields to invoices and invoice lines

alter table sales_invoices
  add column if not exists vat_enabled boolean not null default false,
  add column if not exists vat_rate numeric(5,2) not null default 13.00,
  add column if not exists vat_amount numeric(14,2) not null default 0,
  add column if not exists vat_account_id uuid references accounts(id);

alter table sales_invoice_lines
  add column if not exists vat_amount numeric(14,2) not null default 0;

alter table purchase_invoices
  add column if not exists vat_enabled boolean not null default false,
  add column if not exists vat_rate numeric(5,2) not null default 13.00,
  add column if not exists vat_amount numeric(14,2) not null default 0,
  add column if not exists vat_account_id uuid references accounts(id);

alter table purchase_invoice_lines
  add column if not exists vat_amount numeric(14,2) not null default 0;

-- Update existing records to have default VAT settings
update sales_invoices set vat_enabled = false, vat_rate = 13.00 where vat_enabled is null;
update purchase_invoices set vat_enabled = false, vat_rate = 13.00 where vat_enabled is null;
