const { createClient } = require('@supabase/supabase-js');

// Uses the SERVICE ROLE key, which can create/manage auth users. This must
// only ever run on the backend — never send this key to the frontend.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

module.exports = { supabaseAdmin };
