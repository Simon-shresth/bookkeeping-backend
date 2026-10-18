-- Migration 012: Fiscal years
-- Introduces accounting periods so the books can be closed at year end and
-- the next year opened. Closing is "soft": it only marks a year 'closed' and
-- creates the next year row; opening balances and P&L are computed at report
-- time from date-bounded journal sums, so edits in a closed year still flow
-- through without needing reversal/re-posting of a closing entry.

create table if not exists fiscal_years (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  status      text not null default 'open' check (status in ('open','closed')),
  closed_by   uuid references users(id),
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  unique(company_id, start_date)
);
create index if not exists idx_fiscal_years_company on fiscal_years(company_id, start_date);

-- Backfill: create one open fiscal year for each existing company that has none.
-- Uses companies.fiscal_start when set, otherwise the company creation date.
insert into fiscal_years (company_id, start_date, end_date, status)
select c.id,
  coalesce(c.fiscal_start, c.created_at::date),
  (coalesce(c.fiscal_start, c.created_at::date) + interval '1 year' - interval '1 day')::date,
  'open'
from companies c
where not exists (select 1 from fiscal_years fy where fy.company_id = c.id);
