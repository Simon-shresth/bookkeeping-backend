-- Migration 017: VAT settings for sales and purchases
-- Add VAT enable/disable, rate, and account configuration per company

alter table companies add column if not exists vat_enabled boolean not null default false;
alter table companies add column if not exists vat_rate numeric(5,2) not null default 13.00;
alter table companies add column if not exists vat_account_id uuid references accounts(id);

-- Update existing companies to have default VAT settings (disabled)
-- No data migration needed as defaults are applied