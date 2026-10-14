const express = require('express');
const { pool } = require('../db');
const { getTotals, getAccountBalance } = require('../services/ledger');

const router = express.Router();

function loanAgeBucket(days) {
  if (days < 365) return 'Under 1 yr';
  if (days < 730) return '1–2 yrs';
  if (days < 1825) return '2–5 yrs';
  return 'Over 5 yrs';
}

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
      pool.query(
        `select l.id, l.account_id, l.lender_name, l.principal, l.interest_rate,
                l.start_date::text as start_date, a.name as account_name
         from loans l
         join accounts a on a.id = l.account_id
         where l.company_id = $1
         order by l.start_date asc`,
        [companyId]
      ),
    ]);

    // Enrich each loan with its current outstanding balance from the ledger
    const today = Date.now();
    const loans = await Promise.all(loanRows.map(async (loan) => {
      const outstanding = await getAccountBalance(companyId, loan.account_id);
      const ageDays = loan.start_date
        ? Math.floor((today - new Date(loan.start_date).getTime()) / 86400000)
        : null;
      return {
        id: loan.id,
        lender_name: loan.lender_name || loan.account_name,
        account_name: loan.account_name,
        principal: Number(loan.principal) || 0,
        interest_rate: Number(loan.interest_rate) || null,
        start_date: loan.start_date,
        outstanding,
        age_days: ageDays,
        age_bucket: ageDays !== null ? loanAgeBucket(ageDays) : null,
      };
    }));

    res.json({ totals, lowStock, recentTransactions: recent, loans });
  } catch (err) { next(err); }
});

module.exports = router;
