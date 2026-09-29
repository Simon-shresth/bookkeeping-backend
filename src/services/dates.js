// "Today" as a YYYY-MM-DD string in the company's own timezone. Computed in
// SQL so it's correct regardless of where the server runs (Render uses UTC,
// which is a different calendar day from Kathmandu for ~6 hours every night).
async function companyToday(db, companyId) {
  const { rows } = await db.query(
    "select (now() at time zone timezone)::date::text as d from companies where id = $1",
    [companyId]
  );
  return rows[0]?.d || new Date().toISOString().slice(0, 10);
}

module.exports = { companyToday };
