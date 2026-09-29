require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Applies db/schema.sql (the Phase 1 base) once, then every file in
// db/migrations/ in name order, each exactly once, recording what has run
// in a `schema_migrations` table. Safe to run on every deploy.
//
// A database created before this runner existed (base schema already
// present) is detected and the base is recorded without being re-applied.

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  const client = await pool.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    const applied = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));

    const run = async (name, sql) => {
      console.log(`Applying ${name} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${name} failed: ${err.message}`);
      }
    };

    if (!applied.has('001_base_schema.sql')) {
      const exists = (await client.query("select to_regclass('public.companies') as t")).rows[0].t;
      if (exists) {
        console.log('Base schema already present — recording 001_base_schema.sql without re-running it.');
        await client.query('insert into schema_migrations (name) values ($1)', ['001_base_schema.sql']);
      } else {
        await run('001_base_schema.sql', fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
      }
    }

    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
    for (const file of files) {
      if (applied.has(file)) continue;
      await run(file, fs.readFileSync(path.join(dir, file), 'utf8'));
    }
    console.log('Database is up to date.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
