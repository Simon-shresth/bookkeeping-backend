-- Phase 4: bank reconciliation + payment references + audit indexes.
-- Idempotent (safe to re-run).

create table if not exists bank_reconciliations (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id) on delete cascade,
  account_id         uuid not null references accounts(id),
  statement_date     date not null,
  statement_balance  numeric(14,2) not null,
  created_by         uuid references users(id),
  created_at         timestamptz not null default now()
);
create index if not exists idx_recon_account on bank_reconciliations(account_id, statement_date desc, created_at desc);
create index if not exists idx_recon_company on bank_reconciliations(company_id);

-- A journal line is "cleared" once it belongs to a finished reconciliation.
-- Deleting a reconciliation (undo) automatically un-clears its lines.
alter table journal_lines
  add column if not exists reconciliation_id uuid references bank_reconciliations(id) on delete set null;
create index if not exists idx_lines_recon on journal_lines(reconciliation_id);

-- Cheque / transfer reference on standalone payments.
alter table payments add column if not exists reference text;

create index if not exists idx_audit_entity on audit_logs(company_id, entity, created_at desc);
