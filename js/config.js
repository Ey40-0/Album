// Reemplaza los valores placeholder con los de tu proyecto en Supabase (Settings -> API).
// La anon key es segura en frontend SOLO porque la privacidad está garantizada por las políticas RLS.
export const SUPABASE_URL = 'https://qarraqwopmytcnfwlcmv.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_e8kbZPvS7kqeqRoIXRI9Bw_zNMjqBOB';

// Nombre exacto del bucket privado en Supabase Storage (distingue mayúsculas/minúsculas).
export const BUCKET_NAME = 'Album';

// Tiempo de vida de las URLs firmadas (1 hora) y margen para renovarlas antes de expirar (50 min).
export const SIGNED_URL_TTL_SECONDS = 3600;
export const SIGNED_URL_REFRESH_MS = 50 * 60 * 1000;
