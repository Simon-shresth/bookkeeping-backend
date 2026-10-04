-- 1. Create Employees Table
CREATE TABLE IF NOT EXISTS employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    designation VARCHAR(100),
    phone VARCHAR(50),
    email VARCHAR(255),
    base_salary NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    bank_account_no VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Create Payroll Disbursement Runs Table
CREATE TABLE IF NOT EXISTS payroll_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    month_year VARCHAR(20) NOT NULL, -- Format: YYYY-MM (e.g., "2026-10")
    disbursement_date DATE DEFAULT CURRENT_DATE,
    payment_method VARCHAR(50) DEFAULT 'bank', -- 'cash' or 'bank'
    total_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    journal_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Create Salary Slips / Line Items Table
CREATE TABLE IF NOT EXISTS salary_slips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payroll_run_id UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
    employee_name VARCHAR(255) NOT NULL,
    base_salary NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    allowance_bonus NUMERIC(15, 2) DEFAULT 0.00,
    deductions NUMERIC(15, 2) DEFAULT 0.00,
    net_salary NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_salary_slips_run ON salary_slips(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_month ON payroll_runs(month_year);