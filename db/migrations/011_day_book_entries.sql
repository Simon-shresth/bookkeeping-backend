-- Migration 011: Day Book entries table (petty cash flow tracking)
-- Adds a dedicated day_book_entries table for direct cash inflow/outflow entries.
-- The existing GET /api/daybook journal-based view is preserved; the new table
-- is for manually entered petty cash lines that POST to /api/daybook.

create table if not exists day_book_entries (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  entry_date   date not null,
  account_id   uuid not null references accounts(id),
  type         text not null check (type in ('INFLOW', 'OUTFLOW')),
  amount       numeric(14,2) not null check (amount > 0),
  narration    text,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now()
);

create index if not exists idx_day_book_company_date on day_book_entries(company_id, entry_date);
create index if not exists idx_day_book_account on day_book_entries(account_id);
