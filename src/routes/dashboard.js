const express = require('express');
const { pool } = require('../db');
const { getTotals, getTotalsForPeriod, getAccountBalance, isDebitNormal, getCurrentFiscalYear } = require('../services/ledger');

const router = express.Router();

function buildKeyFigures() {
  return {
    cashSales: 0,
    partialCashSales: 0,
    creditSales: 0,
    partialCreditSales: 0,
    paymentReceived: 0,
    expenses: 0,
    accountsPayable: 0,
    accountsReceivable: 0,
    grossProfit: 0,
    netProfit: 0,
    costOfGoodsSold: 0,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;

    // Get fiscal year info for yearly calculations
    const currentFy = await getCurrentFiscalYear(companyId);
    const fyStart = currentFy ? currentFy.start_date : null;
    const fyEnd = currentFy ? currentFy.end_date : null;
    const today = new Date().toISOString().split('T')[0];
    const yearTill = fyEnd || today;

    const [totals, { rows: lowStock }, { rows: recent }, { rows: loanRows }] = await Promise.all([
      getTotals(companyId),
      pool.query(
        'select id, name, stock, min_stock from products where company_id=$1 and stock <= min_stock order by name',
        [companyId]
      ),
      pool.query(
        `(select s.date, 'Sale' as kind, c.name as party, s.total as amount, s.invoice_number
          from sales_invoices s join customers c on c.id=s.customer_id where s.company_id=$1)
         union all
         (select p.date, 'Purchase' as kind, s.name as party, p.total as amount, p.invoice_number
          from purchase_invoices p join suppliers s on s.id=p.supplier_id where p.company_id=$1)
         union all
         (select e.date, 'Expense' as kind, ca.name as party, e.amount, null as invoice_number
          from expenses e join accounts ca on ca.id=e.category_account_id where e.company_id=$1)
         order by date desc limit 8`,
        [companyId]
      ),
      pool.query(
        `with first_date as (
           select account_id, min(date) as first_date
           from journal_lines jl join journal_entries je on je.id = jl.journal_entry_id
           where je.company_id = $1
           group by account_id
         )
         select a.id as account_id, a.name as account_name,
                coalesce(sum(case when je.date >= fd.first_date then jl.debit else 0 end),0) as debit,
                coalesce(sum(case when je.date >= fd.first_date then jl.credit else 0 end),0) as credit,
                fd.first_date as taken_date,
                (array_agg(je.memo ORDER BY je.created_at) FILTER (WHERE je.memo IS NOT NULL)) [1] as memo
         from accounts a
         left join first_date fd on fd.account_id = a.id
         left join journal_lines jl on jl.account_id = a.id
         left join journal_entries je on je.id = jl.journal_entry_id and je.company_id = $1
         where a.company_id = $1 and a.heading = 'Loans'
         group by a.id, a.name, fd.first_date
         order by a.name`,
        [companyId]
      ),
    ]);

    // Compute loan ageing (same as before)
    const todayMs = Date.now();
    const loanAgeing = await Promise.all(loanRows.map(async (loan) => {
      const debit = Number(loan.debit || 0);
      const credit = Number(loan.credit || 0);
      const balance = credit - debit;
      const takenDateStr = loan.taken_date ? new Date(loan.taken_date).toISOString().split('T')[0] : null;
      const daysSinceStart = takenDateStr ? Math.floor((todayMs - new Date(takenDateStr).getTime()) / 86400000) : null;
      const bucket = daysSinceStart == null ? 'Unknown'
        : daysSinceStart <= 90 ? '0-90 days'
        : daysSinceStart <= 180 ? '91-180 days'
        : daysSinceStart <= 365 ? '181-365 days'
        : '1+ years';
      return {
        id: loan.account_id,
        account_name: loan.account_name || 'Unknown Loan',
        taken_date: takenDateStr,
        memo: loan.memo || null,
        balance,
        days_outstanding: daysSinceStart,
        bucket,
      };
    }));

    // Monthly sales metrics
    const monthlyQuery = await pool.query(
      `select
         to_char(s.date, 'YYYY-MM') as month,
         coalesce(sum(case when s.cash_sale then s.total else 0 end),0) as cash_sales,
         coalesce(sum(case when not s.cash_sale and s.paid_amount > 0 then s.paid_amount else 0 end),0) as partial_cash,
         coalesce(sum(case when not s.cash_sale then s.credit_amount else 0 end),0) as credit_sales,
         coalesce(sum(s.paid_amount),0) as payment_received
       from sales_invoices s
       where s.company_id = $1
       group by to_char(s.date, 'YYYY-MM')
       order by month`,
      [companyId]
    );

    // Expense totals by month
    const monthlyExpenses = await pool.query(
      `select to_char(e.date, 'YYYY-MM') as month, sum(e.amount) as total
       from expenses e
       where e.company_id = $1
       group by to_char(e.date, 'YYYY-MM')
       order by month`,
      [companyId]
    );

    // Purchase totals (accounts payable / COGS tracking)
    const monthlyPurchases = await pool.query(
      `select to_char(p.date, 'YYYY-MM') as month, sum(p.total) as total
       from purchase_invoices p
       where p.company_id = $1
       group by to_char(p.date, 'YYYY-MM')
       order by month`,
      [companyId]
    );

    // Build monthly figures (10 key figures)
    const monthlyMap = {};
    for (const r of monthlyQuery.rows) {
      const m = r.month;
      monthlyMap[m] = buildKeyFigures();
      monthlyMap[m].cashSales = Number(r.cash_sales || 0);
      monthlyMap[m].partialCashSales = Number(r.partial_cash || 0);
      monthlyMap[m].creditSales = Number(r.credit_sales || 0);
      monthlyMap[m].paymentReceived = Number(r.payment_received || 0);
    }

    // Expenses by month
    for (const r of monthlyExpenses.rows) {
      const m = r.month;
      if (!monthlyMap[m]) monthlyMap[m] = buildKeyFigures();
      monthlyMap[m].expenses = Number(r.total || 0);
    }

    // COGS by month from journal entries (heading = 'Cost of Goods Sold')
    const monthlyCOGS = await pool.query(
      `select to_char(je.date, 'YYYY-MM') as month, coalesce(sum(jl.debit) - coalesce(sum(jl.credit),0),0) as cogs
       from journal_lines jl
       join journal_entries je on je.id = jl.journal_entry_id
       join accounts a on a.id = jl.account_id
       where a.heading = 'Cost of Goods Sold' and a.company_id = $1 and je.company_id = $1
       group by to_char(je.date, 'YYYY-MM')
       order by month`,
      [companyId]
    );
    for (const r of monthlyCOGS.rows) {
      const m = r.month;
      if (!monthlyMap[m]) monthlyMap[m] = buildKeyFigures();
      monthlyMap[m].costOfGoodsSold = Math.abs(Number(r.cogs || 0));
    }

    // AR at end of each month (positive balances only per sub-account)
    for (const m of Object.keys(monthlyMap)) {
      const d = monthlyMap[m];
      const monthEnd = m + '-31';
      const [arRes, apRes, payRes] = await Promise.all([
        pool.query(
          `select a.id, coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0) as bal
           from accounts a
           left join journal_lines jl on jl.account_id = a.id
           left join journal_entries je on je.id = jl.journal_entry_id
           where a.company_id = $1 and a.category = 'Assets' and a.heading = 'Accounts Receivable'
             and (je.date <= $2 or je.date is null)
           group by a.id`,
          [companyId, monthEnd]
        ),
        pool.query(
          `select a.id, coalesce(sum(jl.credit),0) - coalesce(sum(jl.debit),0) as bal
           from accounts a
           left join journal_lines jl on jl.account_id = a.id
           left join journal_entries je on je.id = jl.journal_entry_id
           where a.company_id = $1 and a.category = 'Liabilities' and a.heading = 'Accounts Payable'
             and (je.date <= $2 or je.date is null)
           group by a.id`,
          [companyId, monthEnd]
        ),
        pool.query(
          `select coalesce(sum(amount),0) as total from payments
           where company_id = $1 and type = 'customer_receipt' and to_char(date, 'YYYY-MM') = $2`,
          [companyId, m]
        )
      ]);
      d.accountsReceivable = arRes.rows.reduce((sum, r) => sum + Math.max(0, Number(r.bal || 0)), 0);
      d.accountsPayable = apRes.rows.reduce((sum, r) => sum + Math.max(0, Number(r.bal || 0)), 0);
      d.paymentReceived += Number(payRes.rows[0]?.total || 0);
    }

    // Gross / Net profit
    for (const m of Object.keys(monthlyMap)) {
      const d = monthlyMap[m];
      const revenue = d.cashSales + d.partialCashSales + d.creditSales;
      d.grossProfit = revenue - d.costOfGoodsSold;
      d.netProfit = d.grossProfit - d.expenses;
    }

    // Remove partialCreditSales from output (replaced by creditSales using credit_amount)
    for (const m of Object.keys(monthlyMap)) {
      delete monthlyMap[m].partialCreditSales;
    }

    // Yearly calculations (from fiscal year start to today, or all-time if no fy)
    const yearStartStr = fyStart || '1900-01-01';
    const yearTillStr = yearTill || today;

    // Yearly sales metrics from sales_invoices
    const yearlySales = await pool.query(
      `select
         coalesce(sum(case when s.cash_sale then s.total else 0 end),0) as cash_sales,
         coalesce(sum(case when not s.cash_sale and s.paid_amount > 0 then s.paid_amount else 0 end),0) as partial_cash,
         coalesce(sum(case when not s.cash_sale then s.credit_amount else 0 end),0) as credit_sales,
         coalesce(sum(s.paid_amount),0) as payment_received
       from sales_invoices s
       where s.company_id = $1 and s.date >= $2 and s.date <= $3`,
      [companyId, yearStartStr, yearTillStr]
    );

    // Yearly COGS from Cost of Goods Sold journal account
    const yearlyCOGS = await pool.query(
      `select coalesce(sum(jl.debit) - coalesce(sum(jl.credit),0),0) as cogs
       from journal_lines jl
       join journal_entries je on je.id = jl.journal_entry_id
       join accounts a on a.id = jl.account_id
       where a.heading = 'Cost of Goods Sold' and a.company_id = $1 and je.company_id = $1
         and je.date >= $2 and je.date <= $3`,
      [companyId, yearStartStr, yearTillStr]
    );

    const yearlyExpenses = await pool.query(
      `select coalesce(sum(amount), 0) as total from expenses e where e.company_id = $1 and e.date >= $2 and e.date <= $3`,
      [companyId, yearStartStr, yearTillStr]
    );

    const yearlyPurchases = await pool.query(
      `select coalesce(sum(total), 0) as total from purchase_invoices p where p.company_id = $1 and p.date >= $2 and p.date <= $3`,
      [companyId, yearStartStr, yearTillStr]
    );

    // AR/AP balances as of year end (or today)
    // AR is Assets (Debit normal: debit - credit). Summing absolute balances of ALL AR accounts.
    const arBalRes = await pool.query(
      `select a.id, coalesce(sum(jl.debit),0) as debit, coalesce(sum(jl.credit),0) as credit
       from accounts a
       left join journal_lines jl on jl.account_id = a.id
       left join journal_entries je on je.id = jl.journal_entry_id
       where a.company_id = $1 and a.category = 'Assets' and a.heading = 'Accounts Receivable' and (je.date <= $2 or je.date is null)
       group by a.id`,
      [companyId, yearTillStr]
    );
    // AR: only include accounts with positive debit - credit (ignore negative/overpayment balances)
    const arBalVal = arBalRes.rows.reduce((sum, r) => {
      const bal = Number(r.debit) - Number(r.credit);
      return sum + Math.max(0, bal);
    }, 0);

    // AP: only include accounts with positive credit - debit (ignore negative/overpayment balances)
    const apBalVal = apBalRes.rows.reduce((sum, r) => {
      const bal = Number(r.credit) - Number(r.debit);
      return sum + Math.max(0, bal);
    }, 0);

    // AP is Liabilities (Credit normal: credit - debit). Summing absolute balances of ALL AP accounts.
    const apBalRes = await pool.query(
      `select a.id, coalesce(sum(jl.debit),0) as debit, coalesce(sum(jl.credit),0) as credit
       from accounts a
       left join journal_lines jl on jl.account_id = a.id
       left join journal_entries je on je.id = jl.journal_entry_id
       where a.company_id = $1 and a.category = 'Liabilities' and a.heading = 'Accounts Payable' and (je.date <= $2 or je.date is null)
       group by a.id`,
      [companyId, yearTillStr]
    );
    const apBalVal = apBalRes.rows.reduce((sum, r) => sum + (Number(r.credit) - Number(r.debit)), 0);

    const yr = yearlySales.rows[0];
    const yrExp = yearlyExpenses.rows[0];
    const yrPur = yearlyPurchases.rows[0];

    const yearly = buildKeyFigures();
    yearly.cashSales = Number(yr?.cash_sales || 0);
    yearly.partialCashSales = Number(yr?.partial_cash || 0);
    yearly.creditSales = Number(yr?.credit_sales || 0);
    yearly.partialCreditSales = Number(yr?.partial_credit || 0);
    yearly.paymentReceived = Number(yr?.payment_received || 0);
    yearly.expenses = Number(yrExp?.total || 0);
    yearly.costOfGoodsSold = Number(yrPur?.total || 0);
    yearly.accountsReceivable = arBalVal;
    yearly.accountsPayable = apBalVal;

    const grossYear = yearly.cashSales + yearly.partialCashSales + yearly.creditSales + yearly.partialCreditSales - yearly.costOfGoodsSold;
    yearly.grossProfit = grossYear;
    yearly.netProfit = grossYear - yearly.expenses;

    res.json({ totals, lowStock, recentTransactions: recent, loanAgeing, keyFigures: { monthly, yearly } });
  } catch (err) { next(err); }
});

module.exports = router;
