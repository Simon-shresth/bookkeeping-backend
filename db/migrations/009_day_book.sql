-- Migration 009: Day Book view support
-- The Day Book is read from existing journal_entries + journal_lines data.
-- This migration adds an index that makes the daily-aggregate query fast
-- and a view that pre-joins the data the Day Book API needs.

-- Fast lookup of journal lines by date (for opening-balance calculation)
create index if not exists idx_journal_company_date_source
  on journal_entries(company_id, date, source);

-- Day Book view: one row per journal_entry, with per-entry DR/CR totals
-- and the linked party name (customer / supplier) resolved via the memo.
-- The API layer will compute opening/closing cash by summing journal_lines
-- on the Cash account up to the requested date.
create or replace view day_book_view as
select
  je.id,
  je.company_id,
  je.date,
  je.source,
  je.memo,
  je.reference,
  je.created_at,
  coalesce(sum(jl.debit), 0)  as total_debit,
  coalesce(sum(jl.credit), 0) as total_credit
from journal_entries je
left join journal_lines jl on jl.journal_entry_id = je.id
group by je.id, je.company_id, je.date, je.source, je.memo, je.reference, je.created_at;
