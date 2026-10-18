-- Migration 013: Link Day Book entries to journal_entries
-- Allows Day Book cash inflow/outflow entries to post automatic balanced
-- double-entry records affecting the General Ledger and respective accounts.

alter table day_book_entries
  add column if not exists journal_entry_id uuid references journal_entries(id) on delete set null;

create index if not exists idx_day_book_journal_entry on day_book_entries(journal_entry_id);
