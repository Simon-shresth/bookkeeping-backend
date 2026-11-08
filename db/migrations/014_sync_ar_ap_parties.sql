-- Migration 014: Ensure Accounts Receivable and Accounts Payable accounts
-- are synced with customers and suppliers tables respectively.

-- 1. Trim heading whitespace and fix any miscategorized AR/AP accounts
update accounts
set heading = trim(heading)
where heading != trim(heading);

update accounts
set category = 'Liabilities'
where heading = 'Accounts Payable' and category != 'Liabilities';

update accounts
set category = 'Assets'
where heading = 'Accounts Receivable' and category != 'Assets';

-- 2. Backfill missing customers for existing Accounts Receivable accounts
insert into customers (company_id, name, account_id)
select a.company_id, a.name, a.id
from accounts a
where a.heading = 'Accounts Receivable'
  and not exists (
    select 1 from customers c
    where c.company_id = a.company_id and (c.account_id = a.id or lower(c.name) = lower(a.name))
  )
on conflict (company_id, name) do update set account_id = excluded.account_id;

-- 3. Backfill missing suppliers for existing Accounts Payable accounts
insert into suppliers (company_id, name, account_id)
select a.company_id, a.name, a.id
from accounts a
where a.heading = 'Accounts Payable'
  and not exists (
    select 1 from suppliers s
    where s.company_id = a.company_id and (s.account_id = a.id or lower(s.name) = lower(a.name))
  )
on conflict (company_id, name) do update set account_id = excluded.account_id;
