-- Migration 010: Purchase of services & narration on purchase invoices
-- 1. Add narration to purchase_invoices
alter table purchase_invoices
  add column if not exists narration text;

-- 2. Make product_id nullable in purchase_invoice_lines so service lines can exist without a product
alter table purchase_invoice_lines
  alter column product_id drop not null;

-- 3. Add line_type ('product' | 'service'), service description, and expense account reference to lines
alter table purchase_invoice_lines
  add column if not exists line_type text not null default 'product',
  add column if not exists description text,
  add column if not exists account_id uuid references accounts(id);

create index if not exists idx_purchase_lines_account on purchase_invoice_lines(account_id);
