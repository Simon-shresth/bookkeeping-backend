// Writes one row to audit_logs. `db` can be a pg client (inside a transaction,
// so the audit row commits or rolls back together with the change it
// describes) or the pool.
async function audit(db, { companyId, userId, action, entity, entityId, details }) {
  await db.query(
    `insert into audit_logs (company_id, user_id, action, entity, entity_id, details)
     values ($1,$2,$3,$4,$5,$6)`,
    [companyId, userId || null, action, entity, entityId || null, details ? JSON.stringify(details) : null]
  );
}

module.exports = { audit };
