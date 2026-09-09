import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Server-only Realtime client. The secret key is never serialized to the
 * browser or installed on the Raspberry Pi; both consume authenticated SSE
 * streams exposed by this app.
 */
export function createRealtimeAdminClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !secret) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for camera Realtime.",
    );
  }

  return createClient(url, secret, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
