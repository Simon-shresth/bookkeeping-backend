require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { requireAuth, requireSupabaseAuth } = require('./auth');

const accountsRoutes = require('./routes/accounts');
const ledgerRoutes = require('./routes/ledger');
const journalRoutes = require('./routes/journal');
const customersRoutes = require('./routes/customers');
const suppliersRoutes = require('./routes/suppliers');
const productsRoutes = require('./routes/products');
const salesRoutes = require('./routes/sales');
const purchasesRoutes = require('./routes/purchases');
const expensesRoutes = require('./routes/expenses');
const reportsRoutes = require('./routes/reports');
const dashboardRoutes = require('./routes/dashboard');
const onboardingRoutes = require('./routes/onboarding');
const usersRoutes = require('./routes/users');
const paymentsRoutes = require('./routes/payments');
const reconciliationRoutes = require('./routes/reconciliation');
const auditRoutes = require('./routes/audit');
const employeesRoutes = require('./routes/employees');
const salaryRoutes = require('./routes/salary');
const { pool } = require('./db');


const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Basic abuse protection. Tune per environment.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 600 }));

// Liveness + database check. Point an uptime monitor (and Render's health
// check) here; a 503 means the app is up but can't reach PostgreSQL.
app.get('/health', async (req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, db: 'up', time: new Date().toISOString() });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({ ok: false, db: 'down', time: new Date().toISOString() });
  }
});

// Onboarding is mounted BEFORE the blanket requireAuth below: a brand-new
// sign-up has no `users` row yet, so it only needs a valid Supabase token,
// not an existing company.
app.use('/api/onboarding', requireSupabaseAuth, onboardingRoutes);

// Everything else under /api requires a valid Supabase-issued token AND a
// matching row in our own `users` table (which carries company + role).
app.use('/api', requireAuth);

app.get('/api/me', (req, res) => res.json(req.user));

app.use('/api/accounts', accountsRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/purchases', purchasesRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/reconciliation', reconciliationRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/salary', salaryRoutes);


app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler. Zod validation errors and known business-logic
// errors (err.status) get a clean 4xx; anything unexpected is logged and
// returned as a generic 500 so internals never leak to the client.
app.use((err, req, res, next) => {
  if (err.name === 'ZodError') {
    return res.status(400).json({ error: 'Validation failed', details: err.errors });
  }
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err.code === '22P02') { // PostgreSQL: invalid text representation (e.g. a malformed UUID in the URL)
    return res.status(400).json({ error: 'Invalid identifier' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 4000;
const server = app.listen(port, () => console.log(`Bookkeeping API listening on port ${port}`));

// On Render's free plan the service spins down after ~15 min of inactivity,
// causing a 30-second cold start on the next real request. Self-ping every
// 14 minutes keeps it warm. Only runs in production (Render sets NODE_ENV).
if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
  const PING_INTERVAL_MS = 14 * 60 * 1000;
  setInterval(async () => {
    try {
      await fetch(`${process.env.RENDER_EXTERNAL_URL}/health`);
    } catch {
      // ignore — if this fails it just means a cold start will happen anyway
    }
  }, PING_INTERVAL_MS);
}

// Render (and most hosts) send SIGTERM on deploy/restart. Stop taking new
// requests, let in-flight ones (including open DB transactions) finish, then
// close the pool — so a deploy never cuts a ledger write in half.
function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(async () => {
    try { await pool.end(); } catch (e) { console.error(e); }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
