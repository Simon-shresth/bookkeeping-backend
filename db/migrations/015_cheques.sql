create table if not exists cheques (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  cheque_date       date not null,
  customer_id       uuid not null references customers(id),
  bank_name         text not null,
  cheque_number     text not null,
  amount            numeric(14,2) not null,
  drawee_name       text not null,
  cheque_owner      text not null,
  is_cashed         boolean not null default false,
  cashed_amount     numeric(14,2) not null default 0,
  cashed_date       date,
  created_at        timestamptz not null default now()
);
create index if not exists idx_cheques_company on cheques(company_id);
create index if not exists idx_cheques_customer on cheques(customer_id);
