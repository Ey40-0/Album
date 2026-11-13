# Álbum Privado de Fotos

Sitio estático seguro y privado para visualización de fotos familiares, alojado en **GitHub Pages** y respaldado por **Supabase** (plan gratuito) para autenticación y almacenamiento privado en la nube.

---

## Regla de Oro: Qué NO subir NUNCA al repositorio Git

Dado que este proyecto se despliega en un repositorio público de GitHub (necesario para GitHub Pages en el plan Free), **todo lo que esté en Git será público en internet**.

Las fotos y datos personales se mantienen 100% privados únicamente porque **NUNCA tocan Git** y residen en un bucket privado de Supabase protegido por políticas RLS en base de datos.

El archivo [.gitignore](file:///home/ariel/Documentos/Workspace/Personal/Apps/Album/Album/.gitignore) ya protege estos elementos, pero verifica siempre antes de cada commit:

- ❌ `originals/` (tus fotos y videos originales con metadatos y GPS).
- ❌ `processed/` (fotos y miniaturas procesadas).
- ❌ `meta.json` o `captions.json` (títulos y descripciones privadas).
- ❌ `.env` o `.env.local` (contiene tu `SUPABASE_SERVICE_KEY`).
- ❌ La `service_role` key de Supabase (jamás debe estar en archivos frontend ni en Git).

---

## Requisitos previos

- Python 3.9+ con [Pillow](https://python-pillow.org/) instalado (`pip install Pillow`).
- *(Opcional)* Soporte para fotos de iPhone `.heic`: `pip install pillow-heif`.
- Proyecto creado en [Supabase](https://supabase.com/) con plan gratuito.

---

## Guía de Configuración Inicial (Paso a Paso)

### 1. Descargar el cliente local de Supabase (sin CDN)

Para cumplir con la política CSP (`script-src 'self'`), el archivo SDK debe estar guardado localmente en `js/vendor/supabase.js`.

Descarga la versión fija recomendada (`@supabase/supabase-js@2.119.0`):

```bash
# Opción directa vía curl (archivo UMD autocontenido):
curl -sL https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js -o js/vendor/supabase.js

# O mediante npm si tienes Node.js instalado:
npm pack @supabase/supabase-js@2.119.0
tar -xzf supabase-supabase-js-2.119.0.tgz package/dist/umd/supabase.js
mv package/dist/umd/supabase.js js/vendor/supabase.js
rm -rf package supabase-supabase-js-2.119.0.tgz
```

Verifica que el archivo exista ejecutando:
```bash
ls -lh js/vendor/supabase.js
```

---

### 2. Configurar Supabase

#### A. Nombre exacto del bucket
> ⚠️ **ATENCIÓN CRÍTICA DE MAYÚSCULAS/MINÚSCULAS:**
> El bucket en Supabase Storage debe llamarse exactamente **`Album`** (con la primera letra en mayúscula).
> Si en Supabase tu bucket se llama `album` (en minúsculas) o cualquier otra variación, las políticas de seguridad (RLS) no coincidirán y la galería aparecerá vacía con error 403/400.

#### B. Ejecutar el script SQL de seguridad
1. Entra a tu proyecto en **Supabase -> Authentication -> Users** y copia el UUID de tu usuario.
2. Ve a **Authentication -> Providers** y comprueba que **"Anonymous sign-ins" esté DESACTIVADO (Disabled)**.
3. Abre **SQL Editor -> New query**.
4. Pega el contenido de [supabase/setup.sql](file:///home/ariel/Documentos/Workspace/Personal/Apps/Album/Album/supabase/setup.sql).
5. Reemplaza `'TU_USUARIO_UUID'` por el UUID copiado en el paso 1.
6. Ejecuta el script. Esto:
   - Restringe la lectura del bucket `Album` exclusivamente a esa cuenta autorizada.
   - Crea la tabla `ping` para el keep-alive.

---

### 3. Configurar los archivos del frontend

1. Abre [js/config.js](file:///home/ariel/Documentos/Workspace/Personal/Apps/Album/Album/js/config.js) y reemplaza los placeholders con tu **Project URL** y tu **anon key** (obtenidas en Supabase: *Project Settings -> API*).
2. Abre [index.html](file:///home/ariel/Documentos/Workspace/Personal/Apps/Album/Album/index.html) y [album.html](file:///home/ariel/Documentos/Workspace/Personal/Apps/Album/Album/album.html) y actualiza la directiva `<meta http-equiv="Content-Security-Policy">` reemplazando `https://TU-PROYECTO.supabase.co` por tu Project URL real.

---

## Flujo de Trabajo con las Fotos

### Paso 1: Organizar fotos locales
Coloca tus fotos originales en carpetas dentro de `originals/`:
```text
originals/
├── nosotros/
│   ├── 2025-01-01_inicio.jpg
│   └── 2025-02-14_cena.png
└── hijo/
    ├── 2025-03-01_primer_dia.heic
    └── 2025-03-10_parque.jpg
```

### Paso 2: Procesar fotos (optimizar y eliminar EXIF/GPS)
Ejecuta:
```bash
python3 scripts/process_photos.py
```
El script:
- Corrige la rotación física según el sensor de la cámara.
- Convierte a formato WebP (calidad ~80): foto principal (máx. 1600 px) y miniatura (máx. 400 px en subcarpeta `thumbs/`).
- **Elimina todos los metadatos EXIF y coordenadas GPS**.
- Audita todos los archivos generados y calcula el espacio usado contra la cuota gratuita de 1 GB.

### Paso 3 (Opcional): Títulos y descripciones personalizadas (`meta.json`)
Si deseas nombres más legibles para las carpetas o descripciones en fotos específicas, crea un archivo `meta.json` en la raíz de tu proyecto (ignorado por Git):
```json
{
  "sections": {
    "nosotros": "Nosotros",
    "hijo": "Los primeros meses"
  },
  "captions": {
    "nosotros/2025-01-01_inicio.webp": "Año nuevo frente al mar",
    "hijo/2025-03-01_primer_dia.webp": "Su primer paseo en coche"
  }
}
```
*Si no creas este archivo, la galería funciona perfectamente mostrando el nombre de la carpeta formateado y textos alternativos accesibles.*

### Paso 4: Subir a Supabase Storage

#### Opción A (Automática por script):
1. Crea tu archivo `.env` a partir de `.env.example`:
   ```bash
   cp .env.example .env
   ```
2. Completa en `.env` tu `SUPABASE_URL` y tu `SUPABASE_SERVICE_KEY` (*Project Settings -> API -> service_role secret*).
3. Ejecuta:
   ```bash
   python3 scripts/upload_photos.py
   ```
   *(Sube todo a `Album` con `x-upsert: true` respetando carpetas y el archivo `meta.json` si existe).*

#### Opción B (Manual desde el navegador):
Ve a Supabase -> **Storage** -> bucket **Album**, y arrastra las carpetas generadas dentro de `processed/` (junto con `meta.json` si lo creaste).

---

## Probar en Local

Debido a que los navegadores bloquean módulos JavaScript nativos (`<script type="module">`) cuando se abren mediante protocolo `file:///`, inicia un servidor local simple:

```bash
python3 -m http.server 8000
```
Abre en tu navegador: [http://localhost:8000](http://localhost:8000).

---

## Despliegue en GitHub Pages y Keep-alive

### 1. Subir a GitHub
```bash
git add .
git commit -m "feat: álbum privado estático con supabase"
git push origin main
```

### 2. Activar GitHub Pages
1. Ve a tu repositorio en GitHub -> **Settings -> Pages**.
2. En **Build and deployment -> Source**, selecciona **Deploy from a branch**.
3. Elige la rama `main` y la carpeta `/ (root)`.
4. Haz clic en **Save**. En unos minutos tu sitio estará en `https://<tu-usuario>.github.io/<tu-repo>/`.

### 3. Configurar Secrets para el Keep-alive
Para que Supabase no pause el proyecto tras 7 días de inactividad, el workflow [.github/workflows/keepalive.yml](file:///home/ariel/Documentos/Workspace/Personal/Apps/Album/Album/.github/workflows/keepalive.yml) hace un ping a la tabla `ping` cada 3 días.

1. Ve a tu repositorio en GitHub -> **Settings -> Secrets and variables -> Actions**.
2. Haz clic en **New repository secret** y crea:
   - `SUPABASE_URL`: Tu Project URL (`https://xyz.supabase.co`).
   - `SUPABASE_ANON_KEY`: Tu clave pública `anon`.
3. Ve a la pestaña **Actions -> Supabase Keepalive -> Run workflow** para comprobar que el primer ping se ejecuta con éxito (`HTTP 200`).

> ⚠️ **Advertencia de GitHub Actions:**
> GitHub desactiva automáticamente los flujos programados por cron si el repositorio no registra commits durante **60 días consecutivos**.
> Recibirás un correo de aviso de GitHub. Para reactivarlo, solo tienes que entrar a la pestaña **Actions** del repositorio y pulsar el botón **"Enable workflow"** o ejecutarlo manualmente con **"Run workflow"**.

---

## Checklist de Pruebas de Seguridad

Realiza estas comprobaciones antes de entregar el regalo:

- [ ] **Acceso sin sesión**: Abre `https://<tu-usuario>.github.io/<tu-repo>/album.html` en una ventana privada. Debe redirigir de inmediato a `index.html`.
- [ ] **Credenciales incorrectas**: Intenta iniciar sesión con un correo o contraseña equivocados. Debe mostrar el mensaje claro en español sin filtrar detalles de base de datos ni stack traces.
- [ ] **Acceso de usuario autorizado**: Inicia sesión con las credenciales creadas en Supabase. Debe redirigir a `album.html` y mostrar la galería con sus secciones y miniaturas.
- [ ] **Auditoría de red (DevTools)**:
  - En la pestaña *Network*, verifica que las imágenes cargadas correspondan a `thumbs/` en la grilla y a la foto completa únicamente al abrir el Lightbox.
  - Comprueba que las URLs de las fotos sean URLs firmadas con parámetro `token=...` y tiempo de expiración.
- [ ] **Ventana privada (incógnito)**: Comprueba que el inicio de sesión funcione correctamente sin interferencias de extensiones.
- [ ] **Navegación táctil en móvil**: Abre el sitio en tu teléfono, abre una foto en el visor y desliza con el dedo (swipe) hacia los lados para avanzar o retroceder fotos, y toca fuera de la foto para cerrar el visor.
- [ ] **Cierre de sesión**: Haz clic en el botón *"Cerrar sesión"*. Debe revocar el token en Supabase y redirigir a `index.html`. Si intentas dar al botón *"Atrás"* del navegador, no debe mostrar fotos y debe solicitar login de nuevo.
- [ ] **Comprobación de Git**: Ejecuta `git status` y revisa `git log -p` para cerciorarte de que ninguna foto, archivo `.env` o credencial `service_role` haya sido registrada en el historial.
