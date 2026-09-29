-- ============================================================
-- Bookkeeping System — PostgreSQL Schema
-- Multi-tenant (company_id on every business table), double-entry
-- ledger at the core, matching the accounting logic already
-- validated in the localStorage prototype.
-- ============================================================

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ---------- Companies & Users ----------

create table companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  currency      text not null default 'NPR',
  fiscal_start  date,
  created_at    timestamptz not null default now()
);

create type user_role as enum ('admin', 'accountant', 'manager', 'viewer');

-- Users are authenticated via Supabase Auth (auth.users). This table
-- holds app-specific profile + role + company membership, keyed by
-- the Supabase auth user id.
create table users (
  id            uuid primary key,               -- matches supabase auth.users.id
  company_id    uuid not null references companies(id) on delete cascade,
  email         text not null,
  full_name     text,
  role          user_role not null default 'viewer',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index idx_users_company on users(company_id);

-- ---------- Chart of Accounts ----------

create type account_category as enum ('Assets','Liabilities','Equity','Income','Expenses');

create table accounts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  name          text not null,
  heading       text not null,          -- e.g. 'Bank', 'Rent', 'Accounts Receivable'
  category      account_category not null,
  is_system     boolean not null default false,  -- true for seeded headings; blocks deletion
  created_at    timestamptz not null default now(),
  unique(company_id, name)
);
create index idx_accounts_company on accounts(company_id);
create index idx_accounts_heading on accounts(company_id, heading);

-- ---------- Customers & Suppliers ----------
-- Each gets one auto-created Accounts Receivable / Accounts Payable
-- sub-account (account_id), mirroring the client-side ensureSubAccount logic.

create table customers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  name          text not null,
  contact       text,
  account_id    uuid not null references accounts(id),
  created_at    timestamptz not null default now(),
  unique(company_id, name)
);
create index idx_customers_company on customers(company_id);

create table suppliers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  name          text not null,
  contact       text,
  account_id    uuid not null references accounts(id),
  created_at    timestamptz not null default now(),
  unique(company_id, name)
);
create index idx_suppliers_company on suppliers(company_id);

-- ---------- Products / Inventory ----------

create table products (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  name            text not null,
  purchase_price  numeric(14,2) not null default 0,
  sell_price      numeric(14,2) not null default 0,
  stock           numeric(14,2) not null default 0,
  min_stock       numeric(14,2) not null default 0,
  created_at      timestamptz not null default now(),
  unique(company_id, name)
);
create index idx_products_company on products(company_id);

-- ---------- Journal (the double-entry core) ----------

create table journal_entries (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  date          date not null,
  memo          text not null,
  source        text not null,          -- 'Sale' | 'Purchase' | 'Expense' | 'Manual'
  reference     text,                   -- invoice number, when applicable
  created_by    uuid references users(id),
  created_at    timestamptz not null default now()
);
create index idx_journal_company_date on journal_entries(company_id, date);

create table journal_lines (
  id                  uuid primary key default gen_random_uuid(),
  journal_entry_id    uuid not null references journal_entries(id) on delete cascade,
  account_id          uuid not null references accounts(id),
  debit               numeric(14,2) not null default 0,
  credit              numeric(14,2) not null default 0,
  constraint chk_line_side check (debit >= 0 and credit >= 0 and not (debit > 0 and credit > 0))
);
create index idx_lines_entry on journal_lines(journal_entry_id);
create index idx_lines_account on journal_lines(account_id);

-- ---------- Sales ----------

create table sales_invoices (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  invoice_number    text,
  customer_id       uuid not null references customers(id),
  product_id        uuid not null references products(id),
  qty               numeric(14,2) not null,
  price             numeric(14,2) not null,       -- selling price used on this invoice
  total             numeric(14,2) not null,
  cost              numeric(14,2) not null,       -- COGS for this invoice
  paid_amount       numeric(14,2) not null default 0,
  credit_amount     numeric(14,2) not null default 0,
  payment_account_id uuid references accounts(id),
  journal_entry_id  uuid references journal_entries(id) on delete set null,
  date              date not null,
  created_by        uuid references users(id),
  created_at        timestamptz not null default now()
);
create index idx_sales_company on sales_invoices(company_id);
create index idx_sales_invoice_number on sales_invoices(company_id, invoice_number);
create index idx_sales_customer on sales_invoices(customer_id);

-- ---------- Purchases ----------

create table purchase_invoices (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id) on delete cascade,
  invoice_number      text,
  pragyapan_number    text,
  supplier_id         uuid not null references suppliers(id),
  product_id          uuid not null references products(id),
  qty                 numeric(14,2) not null,
  unit_price          numeric(14,2) not null,
  total               numeric(14,2) not null,
  paid_amount         numeric(14,2) not null default 0,
  credit_amount       numeric(14,2) not null default 0,
  payment_account_id  uuid references accounts(id),
  journal_entry_id    uuid references journal_entries(id) on delete set null,
  date                date not null,
  created_by          uuid references users(id),
  created_at          timestamptz not null default now()
);
create index idx_purchases_company on purchase_invoices(company_id);
create index idx_purchases_invoice_number on purchase_invoices(company_id, invoice_number);
create index idx_purchases_supplier on purchase_invoices(supplier_id);

-- ---------- Expenses ----------

create table expenses (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id) on delete cascade,
  category_account_id uuid not null references accounts(id),
  note                text,
  amount              numeric(14,2) not null,
  payment_account_id  uuid not null references accounts(id),
  journal_entry_id    uuid references journal_entries(id) on delete set null,
  date                date not null,
  created_by          uuid references users(id),
  created_at          timestamptz not null default now()
);
create index idx_expenses_company on expenses(company_id);

-- ---------- Standalone Payments (customer receipts / supplier payments made later) ----------

create table payments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  type              text not null check (type in ('customer_receipt','supplier_payment')),
  customer_id       uuid references customers(id),
  supplier_id       uuid references suppliers(id),
  amount            numeric(14,2) not null,
  account_id        uuid not null references accounts(id),
  journal_entry_id  uuid references journal_entries(id) on delete set null,
  date              date not null,
  created_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  constraint chk_payment_party check (
    (type = 'customer_receipt' and customer_id is not null and supplier_id is null) or
    (type = 'supplier_payment' and supplier_id is not null and customer_id is null)
  )
);
create index idx_payments_company on payments(company_id);

-- ---------- Bank accounts & Loans (metadata for specific asset/liability accounts) ----------

create table bank_accounts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  account_id      uuid not null references accounts(id) unique,
  bank_name       text,
  account_number  text,
  branch          text,
  created_at      timestamptz not null default now()
);

create table loans (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  account_id      uuid not null references accounts(id) unique,
  lender_name     text,
  principal       numeric(14,2),
  interest_rate   numeric(5,2),
  start_date      date,
  created_at      timestamptz not null default now()
);

-- ---------- Settings ----------

create table settings (
  company_id  uuid not null references companies(id) on delete cascade,
  key         text not null,
  value       text,
  primary key (company_id, key)
);

-- ---------- Audit Log ----------

create table audit_logs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  user_id     uuid references users(id),
  action      text not null,        -- 'create' | 'update' | 'delete'
  entity      text not null,        -- 'sales_invoice' | 'journal_entry' | ...
  entity_id   uuid,
  details     jsonb,
  created_at  timestamptz not null default now()
);
create index idx_audit_company on audit_logs(company_id, created_at desc);

-- ============================================================
-- Seed function: creates the default Chart of Accounts headings
-- for a newly created company (mirrors DEFAULT_HEADINGS client-side).
-- Accounts Receivable / Accounts Payable are intentionally NOT
-- seeded as literal accounts — those exist only as per-customer /
-- per-supplier sub-accounts, created on demand.
-- ============================================================

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
    (p_company_id, 'Cost of Goods Sold', 'Cost of Goods Sold', 'Expenses', true);
end;
$$ language plpgsql;
