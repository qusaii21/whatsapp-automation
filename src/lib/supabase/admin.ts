import 'server-only';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

// No-op storage adapter — prevents Supabase from touching localStorage/cookies
// on the server (Node v22+ exposes localStorage as a partial global which
// triggers Supabase's browser-storage detection).
const noopStorage = {
  getItem: (_key: string) => null,
  setItem: (_key: string, _value: string) => {},
  removeItem: (_key: string) => {},
};

// ============================================================
// Supabase Admin Client (service role)
// ============================================================
// Uses SUPABASE_SERVICE_ROLE_KEY — bypasses Row-Level Security.
// MUST only be used in server-side code (API routes, services).
// NEVER import this file in client components or pages.
//
// TYPE NOTE:
// We export `SupabaseAdminClient = ReturnType<typeof createAdminClient>`
// to capture the fully-resolved generic type from createClient<Database>.
// Repositories accept this type as their `db` parameter, which allows
// TypeScript to infer .from() and .rpc() return types correctly without
// fighting the internal GenericSchema conditional types.
// ============================================================

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL');
  if (!serviceRoleKey) throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY');

  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: noopStorage,
    },
    global: {
      headers: {
        'x-client-info': 'whatsapp-crm-server/1.0',
      },
    },
  });
}

// Export the resolved client type for use in repository constructors
export type SupabaseAdminClient = ReturnType<typeof createAdminClient>;

let _adminClient: SupabaseAdminClient | null = null;

export function getAdminClient(): SupabaseAdminClient {
  if (_adminClient) return _adminClient;
  _adminClient = createAdminClient();
  return _adminClient;
}
