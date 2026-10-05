-- Migration 006: journal entry remark, employees table, salary disbursements

-- 1. Add remark column to journal_entries (nullable, user-entered narration)
alter table journal_entries add column if not exists remark text;

-- 2. Employees table
create table if not exists employees (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  name         text not null,
  position     text,
  salary       numeric(14,2) not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique(company_id, name)
);
create index if not exists idx_employees_company on employees(company_id);

-- 3. Salary disbursements — one header per batch (month + payment account)
create table if not exists salary_disbursements (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id) on delete cascade,
  month               text not null,          -- 'YYYY-MM'
  payment_account_id  uuid not null references accounts(id),
  total_amount        numeric(14,2) not null,
  journal_entry_id    uuid references journal_entries(id) on delete set null,
  date                date not null,
  created_by          uuid references users(id),
  created_at          timestamptz not null default now()
);
create index if not exists idx_disbursements_company on salary_disbursements(company_id);

-- 4. Per-employee lines for each disbursement
create table if not exists salary_disbursement_lines (
  id                uuid primary key default gen_random_uuid(),
  disbursement_id   uuid not null references salary_disbursements(id) on delete cascade,
  employee_id       uuid not null references employees(id),
  amount            numeric(14,2) not null
);
create index if not exists idx_disbursement_lines on salary_disbursement_lines(disbursement_id);
