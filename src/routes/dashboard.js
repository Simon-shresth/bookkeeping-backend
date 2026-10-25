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
      // Fetch all loans for this company — do not require account join
      pool.query(
        `select l.id, l.lender_name, l.principal, l.interest_rate, l.start_date::text as start_date,
                l.account_id
         from loans l
         where l.company_id = $1
         order by l.start_date asc`,
        [companyId]
      ),
    ]);

    // Compute current outstanding balance per loan from the ledger
    const today = Date.now();
    const loanAgeing = await Promise.all(loanRows.map(async (loan) => {
      // Resolve account name if account exists, else use lender / generic
      let accountName = loan.lender_name || 'Loan';
      let accountId = loan.account_id;
      if (loan.account_id) {
        try {
          const accRes = await pool.query('select name from accounts where id = $1', [loan.account_id]);
          if (accRes.rows[0]) accountName = accRes.rows[0].name;
        } catch (e) { /* ignore */ }
      }
      const balance = accountId ? await getAccountBalance(companyId, accountId) : 0;
      // balance for a Liability account is positive when money is owed
      const daysSinceStart = loan.start_date
        ? Math.floor((today - new Date(loan.start_date).getTime()) / 86400000)
        : null;
      const bucket = daysSinceStart == null ? 'Unknown'
        : daysSinceStart <= 90 ? '0-90 days'
        : daysSinceStart <= 180 ? '91-180 days'
        : daysSinceStart <= 365 ? '181-365 days'
        : '1+ years';
      return {
        id: loan.id,
        lender_name: loan.lender_name || accountName,
        account_name: accountName,
        principal: Number(loan.principal) || null,
        interest_rate: loan.interest_rate != null ? Number(loan.interest_rate) : null,
        start_date: loan.start_date,
        balance,
        days_outstanding: daysSinceStart,
        bucket,
      };
    }));

    res.json({ totals, lowStock, recentTransactions: recent, loanAgeing });
  } catch (err) { next(err); }
});

module.exports = router;
