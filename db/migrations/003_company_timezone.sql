-- Transaction dates default to "today" in the COMPANY's timezone, not the
-- server's (UTC). Change per company with:
--   update companies set timezone = 'Asia/Kolkata' where id = '...';
alter table companies add column if not exists timezone text not null default 'Asia/Kathmandu';
