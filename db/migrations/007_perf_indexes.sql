-- Migration 007: Performance indexes and batched balance queries

-- Compound index for ledger queries (getAccountLedger filters by account_id then joins journal_entries by id)
create index if not exists idx_lines_account_entry on journal_lines(account_id, journal_entry_id);

-- Date-range filtering on sales and purchases (new From/Till filters)
create index if not exists idx_sales_company_date on sales_invoices(company_id, date desc);
create index if not exists idx_purchases_company_date on purchase_invoices(company_id, date desc);

-- AR/AP aging: filtering credit invoices by company
create index if not exists idx_sales_credit on sales_invoices(company_id, credit_amount) where credit_amount > 0;
create index if not exists idx_purchases_credit on purchase_invoices(company_id, credit_amount) where credit_amount > 0;

-- Payments aging queries filter by type
create index if not exists idx_payments_company_type on payments(company_id, type);

-- journal_entries date lookup from ledger service
create index if not exists idx_journal_company_date_id on journal_entries(company_id, date, id);
