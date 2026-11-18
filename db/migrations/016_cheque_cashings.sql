-- Migration 016: Cheque cashings history
-- One row per cash event recorded against a cheque (full or partial payment
-- received). `cheques.cashed_amount` remains the running cumulative total;
-- this table keeps the per-event history (cash date + amount paid) so the
-- Cheques screen can show previous partial cash receipts while recording a
-- new payment against a cheque.

create table cheque_cashings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  cheque_id uuid not null references cheques(id) on delete cascade,
  cash_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  is_full boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_cheque_cashings_company_cheque on cheque_cashings(company_id, cheque_id);
create index idx_cheque_cashings_cheque on cheque_cashings(cheque_id);
