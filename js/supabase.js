import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export function isSupabaseConfigured() {
  return (
    Boolean(SUPABASE_URL) &&
    Boolean(SUPABASE_ANON_KEY) &&
    !SUPABASE_URL.includes('TU-PROYECTO') &&
    !SUPABASE_ANON_KEY.includes('TU-SUPABASE-ANON-KEY')
  );
}

function getSupabaseSdk() {
  const sdk = globalThis.supabase;
  if (!sdk || typeof sdk.createClient !== 'function') {
    throw new Error(
      'No se cargó js/vendor/supabase.js. Descarga @supabase/supabase-js en js/vendor/ antes de abrir el sitio.'
    );
  }
  return sdk;
}

export const supabase = (() => {
  if (!isSupabaseConfigured()) {
    return null;
  }

  const { createClient } = getSupabaseSdk();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Solo usamos email y contraseña; desactivar parsing de tokens en URL evita lecturas innecesarias.
      detectSessionInUrl: false,
    },
  });
})();
