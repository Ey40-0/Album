#!/usr/bin/env python3
"""
scripts/process_photos.py

Procesa fotos locales para el álbum privado:
1. Lee fotos desde originals/<seccion>/*.jpg|jpeg|png|webp|heic|heif
2. Corrige la orientación física según EXIF (exif_transpose) ANTES de descartar metadatos.
3. Genera en processed/<seccion>/<nombre>.webp (lado largo máx. 1600 px, calidad ~80)
   y en processed/<seccion>/thumbs/<nombre>.webp (lado largo máx. 400 px).
4. Guarda en formato WebP SIN metadatos (sin GPS ni información de cámara).
5. Audita al final cada archivo generado con getexif() e info para certificar que no quede EXIF.
6. Reporta el peso total para control del límite gratuito de Supabase (1 GB).
"""

import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    print("ERROR: Pillow no está instalado.", file=sys.stderr)
    print("Instálalo ejecutando: pip install Pillow", file=sys.stderr)
    sys.exit(1)

# Soporte opcional para fotos HEIC (iPhone)
HEIF_SUPPORTED = False
try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF_SUPPORTED = True
except ImportError:
    HEIF_SUPPORTED = False

BASE_DIR = Path(__file__).resolve().parent.parent
ORIGINALS_DIR = BASE_DIR / "originals"
PROCESSED_DIR = BASE_DIR / "processed"

MAIN_MAX_SIDE = 1600
THUMB_MAX_SIDE = 400
WEBP_QUALITY = 80
WEBP_METHOD = 6

STANDARD_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
HEIF_EXTENSIONS = {".heic", ".heif"}


def resize_max_side(img: Image.Image, max_side: int) -> Image.Image:
    """Redimensiona manteniendo la proporción si el lado largo supera max_side."""
    width, height = img.size
    longest = max(width, height)
    if longest <= max_side:
        return img.copy()

    scale = max_side / float(longest)
    new_width = max(1, int(round(width * scale)))
    new_height = max(1, int(round(height * scale)))
    return img.resize((new_width, new_height), Image.Resampling.LANCZOS)


def normalize_color_mode(img: Image.Image) -> Image.Image:
    """Asegura que la imagen esté en RGB o RGBA para compatibilidad con WebP."""
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        return img.convert("RGBA")
    return img.convert("RGB")


def process_image(src_path: Path, dest_main: Path, dest_thumb: Path) -> tuple[int, int]:
    """
    Lee la imagen original, corrige orientación, redimensiona y guarda sin metadatos.
    Devuelve (bytes_main, bytes_thumb).
    """
    dest_main.parent.mkdir(parents=True, exist_ok=True)
    dest_thumb.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(src_path) as raw_img:
        # 1. Corregir orientación física ANTES de quitar metadatos
        oriented = ImageOps.exif_transpose(raw_img)
        if oriented is None:
            oriented = raw_img.copy()

        # 2. Normalizar modo de color (RGB o RGBA)
        normalized = normalize_color_mode(oriented)

        # 3. Generar versión principal (máx 1600 px)
        main_img = resize_max_side(normalized, MAIN_MAX_SIDE)
        # Guardar explícitamente sin pasar exif ni info para evitar filtraciones
        main_img.save(dest_main, format="WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)

        # 4. Generar miniatura (máx 400 px)
        thumb_img = resize_max_side(normalized, THUMB_MAX_SIDE)
        thumb_img.save(dest_thumb, format="WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)

    return dest_main.stat().st_size, dest_thumb.stat().st_size


def audit_processed_directory(directory: Path) -> tuple[int, list[str]]:
    """
    Verifica mediante getexif() e img.info que ningún archivo procesado conserve EXIF ni XMP.
    Devuelve (total_revisados, lista_de_violaciones).
    """
    violations = []
    total = 0

    for file_path in directory.rglob("*.webp"):
        if not file_path.is_file():
            continue
        total += 1
        with Image.open(file_path) as img:
            exif_data = img.getexif()
            has_exif = bool(exif_data and len(exif_data) > 0)
            has_info_meta = any(k in img.info for k in ("exif", "xmp", "photoshop"))

            if has_exif or has_info_meta:
                rel = file_path.relative_to(BASE_DIR)
                violations.append(
                    f"{rel} (exif: {has_exif}, info_keys: {[k for k in ('exif', 'xmp') if k in img.info]})"
                )

    return total, violations


def main():
    print("=" * 60)
    print("Álbum privado — Procesador local de fotos")
    print("=" * 60)

    if not ORIGINALS_DIR.exists():
        ORIGINALS_DIR.mkdir(parents=True, exist_ok=True)
        print(f"Se ha creado la carpeta: {ORIGINALS_DIR.relative_to(BASE_DIR)}/")
        print("Coloca tus fotos organizadas en subcarpetas, por ejemplo:")
        print("  originals/nosotros/2025-01-01_playa.jpg")
        print("  originals/hijo/2025-02-14_parque.heic")
        print("Luego vuelve a ejecutar este script.")
        return

    # Buscar subcarpetas en originals/
    sections = [
        p for p in sorted(ORIGINALS_DIR.iterdir())
        if p.is_dir() and not p.name.startswith(".")
    ]

    if not sections:
        print(f"No hay subcarpetas dentro de {ORIGINALS_DIR.relative_to(BASE_DIR)}/.")
        print("Crea al menos una subcarpeta (ej. 'originals/nosotros/') con tus fotos.")
        return

    total_processed = 0
    total_skipped = 0

    for section_dir in sections:
        section_name = section_dir.name
        files = [
            f for f in sorted(section_dir.iterdir())
            if f.is_file() and not f.name.startswith(".")
        ]

        if not files:
            continue

        print(f"\nProcesando sección: [{section_name}] ({len(files)} archivos)...")

        for file_path in files:
            ext = file_path.suffix.lower()

            if ext in HEIF_EXTENSIONS and not HEIF_SUPPORTED:
                print(
                    f"  [AVISO] Saltando '{file_path.name}': formato HEIC detectado pero "
                    "pillow-heif no está instalado. Ejecuta: pip install pillow-heif",
                    file=sys.stderr,
                )
                total_skipped += 1
                continue

            if ext not in STANDARD_EXTENSIONS and ext not in HEIF_EXTENSIONS:
                print(f"  [OMITIDO] '{file_path.name}' (formato no soportado)")
                total_skipped += 1
                continue

            stem = file_path.stem
            dest_main = PROCESSED_DIR / section_name / f"{stem}.webp"
            dest_thumb = PROCESSED_DIR / section_name / "thumbs" / f"{stem}.webp"

            try:
                bytes_main, bytes_thumb = process_image(file_path, dest_main, dest_thumb)
                total_kb = (bytes_main + bytes_thumb) / 1024
                print(f"  ✓ {stem}.webp (foto: {bytes_main/1024:.0f} KB, thumb: {bytes_thumb/1024:.0f} KB)")
                total_processed += 1
            except Exception as err:
                print(f"  ✗ Error al procesar '{file_path.name}': {err}", file=sys.stderr)
                total_skipped += 1

    print("\n" + "-" * 60)
    print(f"Procesamiento finalizado: {total_processed} fotos listas, {total_skipped} omitidas.")

    if not PROCESSED_DIR.exists() or total_processed == 0:
        print("No se generaron archivos en processed/.")
        return

    # 1. Auditoría estricta de metadatos EXIF
    print("\nIniciando auditoría de privacidad EXIF...")
    audited_count, violations = audit_processed_directory(PROCESSED_DIR)

    if violations:
        print("ALERTA CRÍTICA: Se detectaron metadatos en archivos de salida:", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        print("NO subas estas fotos hasta resolver el problema.", file=sys.stderr)
        sys.exit(2)
    else:
        print(f"✓ Auditoría exitosa: {audited_count} archivos verificados (0 metadatos EXIF / GPS conservados).")

    # 2. Control de cuota del plan gratuito de Supabase (1 GB = 1024 MB)
    total_bytes = sum(f.stat().st_size for f in PROCESSED_DIR.rglob("*") if f.is_file())
    total_mb = total_bytes / (1024 * 1024)
    supabase_quota_mb = 1024.0
    percentage = (total_mb / supabase_quota_mb) * 100

    print("\nUso estimado de almacenamiento en Supabase Storage:")
    print(f"  Total procesado: {total_mb:.2f} MB / {supabase_quota_mb:.0f} MB ({percentage:.1f}% del límite gratuito)")

    if percentage > 90.0:
        print("  ADVERTENCIA: Te estás acercando al límite de 1 GB de Supabase Storage.")
    else:
        print("  ✓ Dentro del margen seguro del plan gratuito.")
    print("=" * 60)


if __name__ == "__main__":
    main()
