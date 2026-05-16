#!/usr/bin/env python3
"""
Synthetic hoodie on pure white — overlapping shapes only so there is NO internal white seam.

Usage:
  pip install pillow
  python tools/generate_test_garment_image.py

Writes: public/test-assets/garment-hoodie-clean-white-bg.png
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("Install Pillow: pip install pillow", file=sys.stderr)
    sys.exit(1)

WHITE = (255, 255, 255)
MAROON = (107, 28, 46)  # #6b1c2e
POCKET = (80, 22, 34)
HEM = (85, 25, 38)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    out_dir = root / "public" / "test-assets"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "garment-hoodie-clean-white-bg.png"

    s = 2
    im = Image.new("RGB", (960 * s, 1200 * s), WHITE)
    draw = ImageDraw.Draw(im)

    def X(x: float) -> float:
        return x * s

    def Y(y: float) -> float:
        return y * s

    # Hood dome (full ellipse — overlaps torso below)
    draw.ellipse([X(270), Y(340), X(690), Y(720)], fill=MAROON)

    # Torso + sleeves: one rounded block overlapping hood by ~140px (no horizontal gap)
    draw.rounded_rectangle(
        [X(210), Y(560), X(750), Y(1110)],
        radius=int(72 * s),
        fill=MAROON,
    )

    # Side sleeve bulge (same color, overlaps torso rect)
    draw.ellipse([X(150), Y(760), X(320), Y(1010)], fill=MAROON)
    draw.ellipse([X(640), Y(760), X(810), Y(1010)], fill=MAROON)

    draw.rounded_rectangle(
        [X(390), Y(900), X(570), Y(1020)],
        radius=int(18 * s),
        fill=POCKET,
    )
    draw.rectangle([X(230), Y(1088), X(730), Y(1110)], fill=HEM)
    draw.rectangle([X(150), Y(980), X(250), Y(1005)], fill=HEM)
    draw.rectangle([X(710), Y(980), X(810), Y(1005)], fill=HEM)

    final = im.resize((960, 1200), Image.Resampling.LANCZOS)
    final.save(out_path, "PNG", optimize=True)
    print(f"Wrote {out_path} ({out_path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
