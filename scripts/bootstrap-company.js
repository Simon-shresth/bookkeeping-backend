// Usage:
//   node scripts/bootstrap-company.js "Company Name" <supabase-auth-user-id> <email>
//
// Run this once after a person signs up through Supabase Auth (email/password),
// to create their company, seed the default Chart of Accounts, and make them
// the first admin. Get <supabase-auth-user-id> from Supabase Dashboard ->
// Authentication -> Users, or from the sign-up response's user.id.

require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const [companyName, authUserId, email] = process.argv.slice(2);
  if (!companyName || !authUserId || !email) {
    console.error('Usage: node scripts/bootstrap-company.js "Company Name" <supabase-auth-user-id> <email>');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const companyRes = await client.query('insert into companies (name) values ($1) returning id', [companyName]);
    const companyId = companyRes.rows[0].id;

    await client.query('select seed_default_accounts($1)', [companyId]);

    await client.query(
      `insert into users (id, company_id, email, role) values ($1, $2, $3, 'admin')
       on conflict (id) do update set company_id = excluded.company_id, role = 'admin'`,
      [authUserId, companyId, email]
    );

    await client.query('COMMIT');
    console.log(`Created company "${companyName}" (${companyId}) with ${email} as admin.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Bootstrap failed:', err.message);
  process.exit(1);
});
