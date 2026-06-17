import 'server-only'
import { createClient } from '@supabase/supabase-js'

// Empty-string fallback avoids a module-load crash during `next build` when env
// vars are not yet populated. Actual requests will fail with a clear Supabase
// error, which is the correct runtime behaviour.
export const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } },
)
