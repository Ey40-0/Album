#!/usr/bin/env python3
"""
scripts/upload_photos.py

Sube las fotos procesadas y meta.json al bucket privado de Supabase Storage:
- Lee credenciales exclusivamente desde el archivo .env local (ignorado por Git).
- Usa la service_role key para omitir RLS durante la subida administrativa.
- Respeta la jerarquía de carpetas (<seccion>/<foto>.webp y <seccion>/thumbs/<foto>.webp).
- Aplica upsert (sobrescribe si el archivo ya existe).
- No requiere librerías externas de terceros (usa la biblioteca estándar de Python).
"""

import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_PATH = BASE_DIR / ".env"
PROCESSED_DIR = BASE_DIR / "processed"


def load_env(env_path: Path) -> dict[str, str]:
    """Carga variables simples desde un archivo .env sin dependencias externas."""
    values = {}
    if not env_path.is_file():
        return values

    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip("\"'").strip()
        values[key] = val
    return values


def upload_file_to_supabase(
    supabase_url: str,
    service_key: str,
    bucket: str,
    remote_path: str,
    file_bytes: bytes,
    content_type: str,
) -> tuple[bool, str]:
    """
    Sube un archivo usando el endpoint REST de Supabase Storage con x-upsert: true.
    """
    # Codificar cada segmento de la ruta por seguridad (preservando los separadores '/')
    safe_remote_path = "/".join(
        urllib.parse.quote(part, safe="") for part in remote_path.split("/")
    )
    endpoint = f"{supabase_url.rstrip('/')}/storage/v1/object/{bucket}/{safe_remote_path}"

    req = urllib.request.Request(
        url=endpoint,
        data=file_bytes,
        method="POST",
        headers={
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "x-upsert": "true",
            "Content-Type": content_type,
        },
    )

    try:
        with urllib.request.urlopen(req) as resp:
            status = resp.status
            if 200 <= status < 300:
                return True, f"HTTP {status}"
            return False, f"HTTP {status}"
    except urllib.error.HTTPError as err:
        try:
            body = err.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return False, f"HTTP {err.code}: {body or err.reason}"
    except Exception as err:
        return False, str(err)


def main():
    print("=" * 60)
    print("Álbum privado — Subida segura a Supabase Storage")
    print("=" * 60)

    env_vars = load_env(ENV_PATH)
    supabase_url = env_vars.get("SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    service_key = env_vars.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")
    bucket = env_vars.get("SUPABASE_BUCKET") or os.environ.get("SUPABASE_BUCKET") or "Album"

    if not supabase_url or "TU-PROYECTO" in supabase_url:
        print("ERROR: Configura SUPABASE_URL en tu archivo .env local.", file=sys.stderr)
        sys.exit(1)

    if not service_key or "TU-SUPABASE-SERVICE-ROLE-KEY" in service_key:
        print("ERROR: Configura SUPABASE_SERVICE_KEY en tu archivo .env local.", file=sys.stderr)
        print("La service_role key se obtiene en Supabase > Project Settings > API.", file=sys.stderr)
        sys.exit(1)

    if not PROCESSED_DIR.exists():
        print(f"ERROR: No existe la carpeta {PROCESSED_DIR.relative_to(BASE_DIR)}/.", file=sys.stderr)
        print("Ejecuta primero: python3 scripts/process_photos.py", file=sys.stderr)
        sys.exit(1)

    # Recolectar archivos a subir desde processed/
    files_to_upload: list[tuple[Path, str, str]] = []

    for file_path in sorted(PROCESSED_DIR.rglob("*")):
        if file_path.is_file() and not file_path.name.startswith("."):
            rel_path = file_path.relative_to(PROCESSED_DIR).as_posix()
            content_type = "image/webp" if file_path.suffix.lower() == ".webp" else "application/octet-stream"
            files_to_upload.append((file_path, rel_path, content_type))

    # Incluir meta.json si existe en raíz o en processed/
    meta_in_processed = PROCESSED_DIR / "meta.json"
    meta_in_root = BASE_DIR / "meta.json"
    if meta_in_processed.is_file():
        files_to_upload.append((meta_in_processed, "meta.json", "application/json"))
    elif meta_in_root.is_file():
        files_to_upload.append((meta_in_root, "meta.json", "application/json"))

    if not files_to_upload:
        print("No se encontraron archivos para subir en processed/.")
        return

    print(f"Bucket destino: '{bucket}' (mayúsculas/minúsculas exactas)")
    print(f"Total de archivos a subir/actualizar: {len(files_to_upload)}\n")

    uploaded = 0
    failed = 0

    for idx, (path, remote_path, content_type) in enumerate(files_to_upload, start=1):
        size_kb = path.stat().st_size / 1024
        print(f"[{idx}/{len(files_to_upload)}] {remote_path} ({size_kb:.0f} KB)... ", end="", flush=True)

        file_bytes = path.read_bytes()
        success, message = upload_file_to_supabase(
            supabase_url=supabase_url,
            service_key=service_key,
            bucket=bucket,
            remote_path=remote_path,
            file_bytes=file_bytes,
            content_type=content_type,
        )

        if success:
            print("OK")
            uploaded += 1
        else:
            print(f"FALLÓ ({message})", file=sys.stderr)
            failed += 1

    print("\n" + "-" * 60)
    print(f"Subida completada: {uploaded} archivos subidos con éxito, {failed} fallidos.")
    if failed > 0:
        print("Revisa si el nombre del bucket coincide exactamente ('Album') y si la service_role key es correcta.", file=sys.stderr)
    print("=" * 60)


if __name__ == "__main__":
    main()
