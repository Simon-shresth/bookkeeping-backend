-- Migration 008: Opening balances
-- Adds an opening_balances table so companies migrating mid-year can enter
-- starting balances for any account without polluting the normal journal.
-- These are journaled as source='Opening Balance' entries for full double-entry
-- integrity, but the UI treats them as a dedicated workflow.

create table if not exists opening_balances (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  account_id    uuid not null references accounts(id),
  amount        numeric(14,2) not null default 0,
  date          date not null,
  journal_entry_id uuid references journal_entries(id) on delete set null,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  unique(company_id, account_id)   -- one opening balance per account
);
create index if not exists idx_opening_balances_company on opening_balances(company_id);
