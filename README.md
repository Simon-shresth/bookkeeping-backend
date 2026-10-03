# Bookkeeping Backend

REST API for the bookkeeping system: double-entry ledger, Sales, Purchases,
Expenses, Customers, Suppliers, Products, Journal Entries, General Ledger,
and Reports (P&L, Balance Sheet, AR/AP aging). Node.js + Express + PostgreSQL,
auth via Supabase.

This is **Phase 1** of the production build (database + backend). The React
frontend and full deployment walkthrough follow in the next phases.

## Architecture

```
Browser (React, phase 2) --HTTPS--> Express API (this) --> PostgreSQL
                                          |
                                    Supabase Auth verifies JWTs
```

Every request to `/api/*` must carry `Authorization: Bearer <supabase-jwt>`.
The API verifies it, looks up the caller's `company_id` and `role` in the
`users` table, and scopes every query to that company — this is what makes
it safely multi-tenant.

## Local setup

1. **Install dependencies**
   ```
   npm install
   ```

2. **Create a Supabase project** (free tier is fine): [supabase.com](https://supabase.com) → New Project.
   - Project Settings → Database → copy the **Connection string** (URI, "Transaction" mode) → this is `DATABASE_URL`.
   - Project Settings → API → copy **Project URL** → this is `SUPABASE_URL`.
   - Project Settings → API → copy **JWT Secret** (under "JWT Settings") → this is `SUPABASE_JWT_SECRET`.

3. **Configure environment**
   ```
   cp .env.example .env
   ```
   Fill in the three Supabase values above.

4. **Apply the database schema**
   ```
   npm run migrate
   ```
   This creates all tables (`companies`, `users`, `accounts`, `journal_entries`,
   `journal_lines`, `customers`, `suppliers`, `products`, `sales_invoices`,
   `purchase_invoices`, `expenses`, `payments`, `bank_accounts`, `loans`,
   `settings`, `audit_logs`) and the `seed_default_accounts()` function.

5. **Create your first user in Supabase Auth**
   - Supabase Dashboard → Authentication → Users → Add user (email + password).
   - Copy that user's **UID**.

6. **Bootstrap your company**
   ```
   npm run bootstrap-company -- "My Company" <the-uid-you-copied> owner@example.com
   ```
   This creates the company, seeds its Chart of Accounts, and makes that
   Supabase user an `admin`.

7. **Run the server**
   ```
   npm run dev
   ```
   Visit `http://localhost:4000/health` — should return `{"ok":true,...}`.

## Testing the API

Get a JWT by signing in through Supabase (the frontend, once built, does this
automatically). For now you can test with `curl` using a token from Supabase's
Auth → Users → "..." menu, or via the Supabase JS client's
`supabase.auth.signInWithPassword(...)`.

```
curl http://localhost:4000/api/dashboard \
  -H "Authorization: Bearer <jwt>"
```

## Roles

`viewer` < `manager` < `accountant` < `admin`. Read endpoints (GET) require
only a valid logged-in user. Creating Customers/Suppliers/Products/Sales/
Purchases/Expenses requires `manager` or higher. Posting/editing/deleting
Journal Entries and creating new Chart-of-Accounts sub-accounts requires
`accountant` or higher, since those touch the ledger directly. Managing
users (`/api/users/*`) requires `admin`.

## Auth flows (Phase 3)

- **New company sign-up**: the frontend calls `supabase.auth.signUp()`
  directly, then `POST /api/onboarding/company` with a company name. That
  route only requires a valid Supabase token (`requireSupabaseAuth`), not an
  existing `users` row — it's how the very first row gets created. It makes
  the caller `admin` of a brand-new company with a freshly seeded Chart of
  Accounts.
- **Inviting a teammate**: `POST /api/users/invite` (`admin` only) uses the
  Supabase **service role** key to create/invite the auth user and emails
  them a link to set a password. Their `users` row (with the role you chose)
  is created immediately, so access is live as soon as they finish signing
  in.
- **Changing a teammate's role or deactivating them**: `PATCH /api/users/:id`
  (`admin` only). An admin can't deactivate or demote their own account —
  there always needs to be at least one active admin.
- **Password reset**: handled entirely by Supabase client-side
  (`resetPasswordForEmail` / `updateUser`) — no backend endpoint needed.

## Deploying (Render)

1. Push this folder to a GitHub repo.
2. Render Dashboard → New → Blueprint → point it at the repo (it will read `render.yaml`).
3. Fill in the environment variables Render prompts for (same values as your `.env`).
4. Deploy. Your API will be live at `https://<your-service>.onrender.com`.
5. Once the frontend has a real domain, update `CORS_ORIGIN` to match it exactly.

## What's new in Phase 4

- **Payments** (`/api/payments`) — record money received from a customer or
  paid to a supplier, separate from invoices. Aging reports apply payments to
  the oldest credit invoices first (FIFO) when generated, so invoices
  themselves are never rewritten.
- **Invoice PDFs** — `GET /api/sales/:id/pdf` returns a printable invoice.
  Note: only Latin characters render correctly today (see
  `docs/OPERATIONS.md` for the Unicode font upgrade path).
- **Bank reconciliation** (`/api/reconciliation`) — match ledger transactions
  against a bank statement until the difference is zero, then lock them in.
  Reconciled transactions can no longer be edited or deleted (enforced in
  `reverseJournalEntry`) until the reconciliation is undone.
- **Audit log** (`/api/audit`, admin only) — every create/update/delete of a
  sale, purchase, expense, payment, journal entry, reconciliation or user is
  recorded in the same database transaction as the change itself, so the two
  can never drift apart.
- **Company timezone** — `companies.timezone` (default `Asia/Kathmandu`)
  determines what "today" means for a new transaction's default date,
  computed in SQL rather than on the server's own clock.
- **Operational readiness** — `npm run backup`, a real database check on
  `/health` (wired into Render's health check), graceful shutdown on
  deploy/restart, and a versioned migration runner (`npm run migrate` now
  applies `db/schema.sql` once and everything in `db/migrations/` in order,
  tracked so nothing re-runs). See `docs/OPERATIONS.md`.

## What's new in this round of changes

- **Nepali number formatting** — every amount (screen and PDF) now uses
  lakh/crore digit grouping (e.g. Rs. 12,34,567.89) via `src/services/numberFormat.js`.
- **Multiple products per invoice** — Sales and Purchases are now a header +
  line-items model (`sales_invoice_lines` / `purchase_invoice_lines`), not
  one product per invoice. **This is a breaking schema change** — back up
  your database before running `npm run migrate` if it has real entries;
  existing single-product sales/purchases cannot be carried forward
  automatically (see the migration file's note for why).
- **Units of measurement** — every product has a unit (pcs, kg, ltr, etc.),
  shown throughout Sales/Purchases/Products and snapshotted onto each line
  item at the time of the transaction.
- **Cash Sale and Discount** (Sales only) — a cash sale bypasses Accounts
  Receivable entirely; a discount posts to a new "Discount Allowed" expense
  account rather than silently reducing reported revenue.
- **Invoices and payments are now separate, linked ledger entries** — an
  invoice always posts its full amount to AR/AP; any amount paid at the time
  of invoicing is recorded as its own linked payment (`src/services/payments.js`),
  so the General Ledger shows the real invoice and the real payment against
  it, not a pre-netted outstanding figure. Aging reports account for this to
  avoid double-counting.
- **General Ledger PDF export** — `GET /api/ledger/:accountId/pdf?from=&till=`,
  with a real computed opening balance for the period.
- **Search in Sales/Purchases** only queries the server on Enter/Search-click,
  not on every keystroke (frontend change, mentioned here since it affects
  how you'll use these endpoints during testing).

## What's next (later phases)

- **Phase 2**: React frontend, calling this API, replacing the current
  localStorage prototype.
- **Phase 3**: Supabase Auth wiring in the frontend (sign up / sign in / role-aware UI).
- **Phase 4**: Production polish — PDF invoice generation, bank reconciliation,
  audit log viewer, backups, custom domain + SSL.
