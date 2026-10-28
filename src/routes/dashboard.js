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

    // Monthly unfiltered (all-time monthly aggregation from sales_invoices + payments + expenses + purchases)
    const monthlyQuery = await pool.query(
      `select
         to_char(s.date, 'YYYY-MM') as month,
         sum(case when s.cash_sale then s.total else 0 end) as cash_sales,
         sum(case when not s.cash_sale and s.paid_amount > 0 then s.paid_amount else 0 end) as partial_cash,
         sum(case when not s.cash_sale then s.total else 0 end) as credit_sales,
         sum(case when not s.cash_sale and s.paid_amount > 0 then s.paid_amount else 0 end) as partial_credit,
         sum(s.paid_amount) as payment_received,
         sum(s.total) as gross_sales
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

    // Build monthly figures
    const monthlyMap = {};
    for (const r of monthlyQuery.rows) {
      const m = r.month;
      monthlyMap[m] = buildKeyFigures();
      monthlyMap[m].cashSales = Number(r.cash_sales || 0);
      monthlyMap[m].partialCashSales = Number(r.partial_cash || 0);
      monthlyMap[m].creditSales = Number(r.credit_sales || 0);
      monthlyMap[m].partialCreditSales = Number(r.partial_credit || 0);
      monthlyMap[m].paymentReceived = Number(r.payment_received || 0);
    }

    // Add expenses
    for (const r of monthlyExpenses.rows) {
      const m = r.month;
      if (!monthlyMap[m]) monthlyMap[m] = buildKeyFigures();
      monthlyMap[m].expenses = Number(r.total || 0);
    }

    // Add purchases (approximates COGS / AP)
    for (const r of monthlyPurchases.rows) {
      const m = r.month;
      if (!monthlyMap[m]) monthlyMap[m] = buildKeyFigures();
      monthlyMap[m].costOfGoodsSold = Number(r.total || 0);
    }

    // Calculate gross/net profit: gross = cash + partial + credit + partial_credit - COGS
    // Net = gross - expenses
    // AR/AP from journal balances at month end (simplified: use totals from ledger)
    for (const m of Object.keys(monthlyMap)) {
      const d = monthlyMap[m];
      const gross = d.cashSales + d.partialCashSales + d.creditSales + d.partialCreditSales - d.costOfGoodsSold;
      d.grossProfit = gross;
      d.netProfit = gross - d.expenses;
    }

    const monthly = monthlyMap;

    // Yearly calculations (from fiscal year start to today, or all-time if no fy)
    const yearStartStr = fyStart || '1900-01-01';
    const yearTillStr = yearTill || today;

    // Yearly sales metrics from sales_invoices
    const yearlySales = await pool.query(
      `select
         coalesce(sum(case when s.cash_sale then s.total else 0 end), 0) as cash_sales,
         coalesce(sum(case when not s.cash_sale and s.paid_amount > 0 then s.paid_amount else 0 end), 0) as partial_cash,
         coalesce(sum(case when not s.cash_sale then s.total else 0 end), 0) as credit_sales,
         coalesce(sum(case when not s.cash_sale and s.paid_amount > 0 then s.paid_amount else 0 end), 0) as partial_credit,
         coalesce(sum(s.paid_amount), 0) as payment_received
       from sales_invoices s
       where s.company_id = $1 and s.date >= $2 and s.date <= $3`,
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
    const arBal = await pool.query(
      `select coalesce(sum(jl.debit),0) as debit, coalesce(sum(jl.credit),0) as credit
       from accounts a left join journal_lines jl on jl.account_id = a.id left join journal_entries je on je.id = jl.journal_entry_id
       where a.company_id = $1 and a.category = 'Assets' and a.heading = 'Accounts Receivable' and (je.date <= $2 or je.date is null)`,
      [companyId, yearTillStr]
    );
    const arBalVal = Number(arBal.rows[0]?.debit || 0) - Number(arBal.rows[0]?.credit || 0);

    const apBal = await pool.query(
      `select coalesce(sum(jl.debit),0) as debit, coalesce(sum(jl.credit),0) as credit
       from accounts a left join journal_lines jl on jl.account_id = a.id left join journal_entries je on je.id = jl.journal_entry_id
       where a.company_id = $1 and a.category = 'Liabilities' and a.heading = 'Accounts Payable' and (je.date <= $2 or je.date is null)`,
      [companyId, yearTillStr]
    );
    const apBalVal = Number(apBal.rows[0]?.credit || 0) - Number(apBal.rows[0]?.debit || 0);

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
