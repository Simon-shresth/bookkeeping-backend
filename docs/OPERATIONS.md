# Operations Guide

Practical notes for running the bookkeeping system in production.

## 1. Backups

Financial records are the one thing you can't regenerate. Treat backups as a
requirement, not a nice-to-have.

**Recommended setup (both, not either):**

1. **Provider backups.** Supabase's paid plans include daily backups and
   optional point-in-time recovery. The free plan does **not** — if you're
   on free, you are relying entirely on step 2.
2. **Your own off-site copy.** Run `npm run backup` on a schedule (cron on a
   server you control, or a scheduled job) and copy the resulting
   `backups/*.sql.gz` somewhere **encrypted and separate from Supabase**
   (e.g. an encrypted bucket in a different cloud account). Keep at least 30
   days of dailies.

```bash
BACKUP_DATABASE_URL="postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" npm run backup
```

- Use the **direct** connection (port 5432) or session pooler for `pg_dump`.
  The transaction pooler (port 6543) does not support it.
- Backup files contain every customer, supplier and transaction. Encrypt them
  (`gpg --symmetric` or your storage provider's server-side encryption), and
  never commit them to git (`backups/` is already in `.gitignore`).

### Restore — and test it

A backup you've never restored is a hope, not a backup. At least once before
go-live, and quarterly after:

```bash
createdb bookkeeping_restore_test
gunzip -c backups/bookkeeping-<timestamp>.sql.gz | psql bookkeeping_restore_test
psql bookkeeping_restore_test -c "select count(*) from journal_entries;"
```

Then point a local backend at that database and confirm the Balance Sheet
report shows **✓ balanced**.

## 2. Migrations

`npm run migrate` applies `db/schema.sql` once, then each file in
`db/migrations/` exactly once, tracked in the `schema_migrations` table. It's
safe to run on every deploy, and `render.yaml` runs it as part of the build —
so a failing migration fails the deploy instead of shipping a broken app.

Rules for adding one: new file `db/migrations/00N_description.sql`, numbered
in order, **never edit a migration that has already been applied** (add a new
one), and prefer `if not exists` / `add column if not exists` so it's
re-runnable. Take a backup before applying anything destructive.

## 3. Monitoring

- **Uptime:** point a monitor (UptimeRobot, Better Stack, etc.) at
  `GET /health`. It returns `200 {"db":"up"}` when healthy and `503` when the
  app can't reach PostgreSQL. Render's own health check is already set to it.
- **Free-tier note:** Render's free web services sleep after inactivity, so
  the first request after a quiet period is slow (cold start). Move to a paid
  instance for anything customers or staff rely on daily.
- **Errors:** unexpected errors are logged to stdout (visible in Render's
  Logs). Consider adding an error tracker (e.g. Sentry) before launch.
- **Audit log:** admins can review who created/changed/deleted invoices,
  purchases, expenses, payments, journal entries, bank reconciliations and
  users under **Audit Log**. Entries are written in the same database
  transaction as the change, so they can't drift apart.

## 4. Data-integrity rules the system enforces

- Every posted entry must balance (debits = credits) or it is rejected.
- Editing/deleting a sale, purchase, expense or payment reverses its old
  ledger effect and stock movement first, all in one transaction.
- A transaction that has been **cleared in a bank reconciliation cannot be
  edited or deleted** until that reconciliation is undone.
- Payments never modify invoices. Aging reports apply each customer's/
  supplier's payments to their oldest credit invoices (FIFO) when generated.
- Customers, suppliers and products that appear on any transaction cannot be
  deleted; financial history is preserved.

## 5. Token verification (how sign-in actually gets checked)

Supabase signs sign-in tokens one of two ways depending on when a project
was created: an older shared-secret method (HS256), or the current default,
a public/private key pair (ES256 or RS256). The backend (`src/auth.js`)
detects which one each token uses and verifies it correctly either way, with
no configuration needed for the current default — `SUPABASE_JWT_SECRET` is
only read for projects still on the legacy method.

This logic is covered by real cryptographic tests (self-signed test tokens
for both methods, including tampered signatures, wrong keys, unknown key
IDs, and expired tokens), not just a syntax check.

## 6. Known limitations (be aware before go-live)

- **Non-Latin text in PDF invoices.** The invoice PDF uses built-in fonts
  that only cover Latin characters; anything else (e.g. Devanagari in a
  customer name) prints as `?`. The fix is embedding a Unicode font (add
  `@pdf-lib/fontkit` and bundle e.g. Noto Sans Devanagari) — not done yet.
- **Overpayments** are allowed (they show as a credit balance on the
  customer/supplier ledger) but there's no dedicated "advance" workflow.
- **No due dates / payment terms.** Aging is measured from invoice date.
- **Single currency per company**, and no period-end closing (opening
  balances in the General Ledger are always 0).
- **Tax (VAT/withholding) is not modelled** — the original feature list
  mentions it; it needs its own design with your accountant.
- **Not independently audited.** This code has been syntax-checked and its
  key logic unit-tested in isolation, but it has not been run end-to-end
  against a live database. Run a full walkthrough with realistic data — and
  have an accountant review the ledger output — before relying on it.
