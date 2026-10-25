const express = require('express');
const { pool } = require('../db');
const { getTotals, getAccountBalance } = require('../services/ledger');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;

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
      // Fetch accounts with heading 'Loans', compute balance up to now,
      // and get first journal entry date/memo (when taken)
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

    // Compute current outstanding balance per loan account from its journal
    const today = Date.now();
    const loanAgeing = await Promise.all(loanRows.map(async (loan) => {
      const debit = Number(loan.debit || 0);
      const credit = Number(loan.credit || 0);
      // Liabilities (Loans) are credit-normal: balance = credit - debit (positive = owed)
      const balance = credit - debit;
      const takenDateStr = loan.taken_date ? new Date(loan.taken_date).toISOString().split('T')[0] : null;
      const daysSinceStart = takenDateStr
        ? Math.floor((today - new Date(takenDateStr).getTime()) / 86400000)
        : null;
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

    res.json({ totals, lowStock, recentTransactions: recent, loanAgeing });
  } catch (err) { next(err); }
});

module.exports = router;
