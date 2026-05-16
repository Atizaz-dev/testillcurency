#!/usr/bin/env python3
"""
Cut out a garment with rembg (U²-Net–based segmentation, MIT-licensed).
Use when the subject and background are similar colors (e.g. red hoodie on red wall) —
color/edge heuristics in the browser cannot separate them reliably.

Install (once):
  pip install -r tools/requirements-tools.txt

Run:
  python tools/segment_garment.py path/to/photo.jpg path/to/cutout.png

Then in the studio: load the same photo as the garment image, open the details under
step 1, and choose the cutout PNG (transparent background = alpha mask).
"""
from __future__ import annotations

import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 3:
        print(
            "Usage: python tools/segment_garment.py <input.jpg> <output.png>",
            file=sys.stderr,
        )
        sys.exit(2)
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    if not src.is_file():
        print(f"Not found: {src}", file=sys.stderr)
        sys.exit(1)
    try:
        from rembg import remove
    except ImportError:
        print(
            "Missing rembg. Install with:\n  pip install -r tools/requirements-tools.txt",
            file=sys.stderr,
        )
        sys.exit(1)
    data = src.read_bytes()
    out = remove(data)
    dst.write_bytes(out)
    print(f"Wrote {dst.resolve()} ({len(out) // 1024} KB)")


if __name__ == "__main__":
    main()
