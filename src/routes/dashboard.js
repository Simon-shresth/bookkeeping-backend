const express = require('express');
const { pool } = require('../db');
const { getTotals } = require('../services/ledger');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const companyId = req.user.company_id;
    const totals = await getTotals(companyId);

    const { rows: lowStock } = await pool.query(
      'select id, name, stock, min_stock from products where company_id=$1 and stock <= min_stock order by name',
      [companyId]
    );

    const { rows: recent } = await pool.query(
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
    );

    res.json({ totals, lowStock, recentTransactions: recent });
  } catch (err) { next(err); }
});

module.exports = router;
