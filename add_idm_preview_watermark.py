#!/usr/bin/env python3
"""
Add a diagonal "PREVIEW" watermark to every page of preview_IDM.pdf.

This script reads the source Infor IDM Administration Technical User Guide,
takes the first 5 pages, applies a semi-transparent PREVIEW watermark to each,
and writes the result to BOTH preview folders the site uses (src/ and _site/).

Run from anywhere. No CLI args needed.

Setup (one-time):
    pip install pymupdf

Run:
    python add_idm_preview_watermark.py
"""
import os
import sys

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF not installed. Run:  pip install pymupdf")

# --- Config ----------------------------------------------------------------
BASE = r"C:\Users\raika\ClaudeAI\Fullonbaan\training"
SOURCE_PDF = os.path.join(BASE, "Infor_IDM_Administration_Technical_User_Guide.pdf")
OUTPUTS = [
    os.path.join(BASE, "src",   "preview", "preview_IDM.pdf"),
    os.path.join(BASE, "_site", "preview", "preview_IDM.pdf"),
]
PAGES_TO_KEEP = 5
WATERMARK_TEXT = "PREVIEW"
FONT_SIZE = 110
COLOR_RGB = (0.65, 0.65, 0.70)  # light gray
ALPHA = 0.22                    # 22% opacity
ROTATION_DEG = 45
# ---------------------------------------------------------------------------


def build_preview_with_watermark(source_path: str, output_path: str) -> None:
    if not os.path.exists(source_path):
        raise FileNotFoundError(f"Source PDF not found: {source_path}")

    src = fitz.open(source_path)

    # Build a new doc containing just the first N pages
    out = fitz.open()
    last = min(PAGES_TO_KEEP, src.page_count) - 1
    out.insert_pdf(src, from_page=0, to_page=last)
    src.close()

    # Apply diagonal PREVIEW watermark on every page
    for page in out:
        rect = page.rect
        cx = rect.width / 2
        cy = rect.height / 2

        # Approx text width to center it after rotation
        approx_w = FONT_SIZE * 0.55 * len(WATERMARK_TEXT)
        # Place text so its midpoint is roughly at the page center
        x = cx - approx_w / 2 * 0.7   # nudged for rotation
        y = cy + FONT_SIZE / 3

        page.insert_text(
            (x, y),
            WATERMARK_TEXT,
            fontsize=FONT_SIZE,
            fontname="helv",
            color=COLOR_RGB,
            rotate=ROTATION_DEG,
            fill_opacity=ALPHA,
            stroke_opacity=ALPHA,
            overlay=True,
        )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    out.save(output_path, garbage=4, deflate=True)
    out.close()
    print(f"  OK  -> {output_path}")


def main() -> int:
    print(f"Source: {SOURCE_PDF}")
    print(f"Pages : first {PAGES_TO_KEEP}")
    print(f"Mark  : '{WATERMARK_TEXT}' (rotated {ROTATION_DEG}°, alpha {ALPHA})")
    print("Writing watermarked previews:")
    for path in OUTPUTS:
        build_preview_with_watermark(SOURCE_PDF, path)
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
