-- ============================================================================
-- setup.sql - Configuración de seguridad (RLS) y tabla keepalive en Supabase
-- ============================================================================
-- INSTRUCCIONES:
-- 1. Ve a tu proyecto en Supabase -> SQL Editor.
-- 2. Abre una nueva consulta (New query), pega este archivo y REEMPLAZA
--    el placeholder 'TU_USUARIO_UUID' por el UUID del usuario único autorizado.
--    (El UUID se obtiene en Supabase -> Authentication -> Users).
-- 3. IMPORTANTE DE SEGURIDAD:
--    Ve a Authentication -> Providers y verifica que "Anonymous sign-ins"
--    esté DESACTIVADO (Disabled). De lo contrario, un atacante no autenticado
--    podría obtener un token anónimo con rol 'authenticated'.
-- 4. Ejecuta este script. NO crees políticas de INSERT, UPDATE o DELETE
--    para usuarios normales: las subidas las harás tú vía service_role o Dashboard.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PARTE 1: POLÍTICA RLS PARA EL BUCKET PRIVADO DE STORAGE
-- ----------------------------------------------------------------------------
-- En Supabase, storage.objects ya tiene RLS activado por defecto.
-- No se debe ejecutar ALTER TABLE sobre storage.objects porque pertenece
-- a un rol interno del sistema (supabase_storage_admin).

-- Eliminamos la política previa si ya existiera para evitar duplicados al reejecutar.
DROP POLICY IF EXISTS "album_select_authorized_users_only" ON storage.objects;

-- Creamos la política estricta de solo lectura (SELECT).
-- Esta política permite:
--  1) Que el rol sea 'authenticated' (usuario con sesión activa).
--  2) Que el bucket consultado sea exactamente 'Album' (distingue mayúsculas/minúsculas).
--  3) Que el identificador de usuario (auth.uid()) coincida ÚNICAMENTE con la cuenta autorizada.
CREATE POLICY "album_select_authorized_users_only"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  -- NOMBRE CENTRALIZADO DEL BUCKET:
  -- Debe coincidir exactamente con el nombre de tu bucket en Supabase Storage.
  bucket_id = 'Album'
  AND
  -- IDENTIFICADOR DEL ÚNICO USUARIO AUTORIZADO:
  -- Reemplaza este valor con el UUID copiado desde Authentication -> Users.
  auth.uid() = 'TU_USUARIO_UUID'
);

-- NOTA: No agregamos ninguna política para INSERT, UPDATE o DELETE.
-- Por defecto en PostgreSQL, sin política no hay permiso. Esto garantiza que
-- ningún usuario desde el navegador pueda subir, modificar o borrar fotos.


-- ----------------------------------------------------------------------------
-- PARTE 2: TABLA PING PARA EL KEEPALIVE DE GITHUB ACTIONS
-- ----------------------------------------------------------------------------
-- Supabase en su plan gratuito pausa proyectos tras 7 días de inactividad de base de datos.
-- Esta tabla permite que un workflow de GitHub Actions haga una petición GET periódica
-- usando la anon key pública sin exponer datos privados ni tocar el bucket.

-- Creamos una tabla mínima con una sola columna de ID y una marca de tiempo.
CREATE TABLE IF NOT EXISTS public.ping (
  id integer PRIMARY KEY,
  last_ping timestamptz NOT NULL DEFAULT now()
);

-- Insertamos la fila única requerida para responder al GET (id = 1).
INSERT INTO public.ping (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Activamos Row Level Security en la tabla ping.
ALTER TABLE public.ping ENABLE ROW LEVEL SECURITY;

-- Eliminamos cualquier política anterior en la tabla ping.
DROP POLICY IF EXISTS "allow_anon_select_ping_only" ON public.ping;

-- Permitimos que la clave pública (rol 'anon') pueda hacer SELECT exclusivamente a esta tabla.
-- No permite INSERT, UPDATE ni DELETE, solo lectura de la fila de ping.
CREATE POLICY "allow_anon_select_ping_only"
ON public.ping
FOR SELECT
TO anon
USING (true);
