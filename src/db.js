const { Pool, types } = require('pg');

// DATE columns -> plain 'YYYY-MM-DD' strings. By default node-pg turns them into
// JS Dates at local midnight, which shifts the day when the server isn't in UTC
// and serialises to noisy ISO timestamps in the API.
types.setTypeParser(1082, (v) => v);
// NUMERIC -> JS numbers (our money columns are numeric(14,2), well within
// double precision). Without this they arrive as strings.
types.setTypeParser(1700, (v) => parseFloat(v));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL error on idle client', err);
});

// Convenience: run a callback inside a transaction, with automatic
// commit/rollback. Every multi-step ledger operation (post a sale,
// reverse a purchase, etc.) goes through this so a failure partway
// through never leaves the books half-updated.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
