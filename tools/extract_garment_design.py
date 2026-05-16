#!/usr/bin/env python3
"""
Extract the chest print from a flat-lay product photo as a transparent PNG plus
placement metadata, for testing the same design on other garment colors.

Depends: pip install numpy opencv-python-headless

Usage:
  python tools/extract_garment_design.py <input.webp|jpg> <output.png> [meta.json]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np


def _fabric_reference_bgr(bgr: np.ndarray) -> np.ndarray:
    h, w = bgr.shape[:2]
    r0, r1 = int(h * 0.58), int(h * 0.72)
    c0, c1 = int(w * 0.38), int(w * 0.62)
    patch = bgr[r0:r1, c0:c1].reshape(-1, 3).astype(np.float32)
    return np.median(patch, axis=0)


def build_design_alpha(bgr: np.ndarray) -> np.ndarray:
    """Binary-ish alpha (0 / 255) covering ink + bar + white-on-dark text."""
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    s = hsv[:, :, 1]
    ref = _fabric_reference_bgr(bgr)
    diff = np.linalg.norm(bgr.astype(np.float32) - ref, axis=2)

    alpha = np.zeros((h, w), np.uint8)
    x0, x1 = int(w * 0.14), int(w * 0.86)

    y0, y1 = int(h * 0.32), int(h * 0.46)
    m_u = (s[y0:y1, x0:x1] > 18) | (gray[y0:y1, x0:x1] < 185)
    alpha[y0:y1, x0:x1] = np.where(m_u, 255, alpha[y0:y1, x0:x1])

    y2, y3 = int(h * 0.44), int(h * 0.54)
    bar = (diff[y2:y3, x0:x1] > 10.5) | (gray[y2:y3, x0:x1] < 198)
    alpha[y2:y3, x0:x1] = np.maximum(alpha[y2:y3, x0:x1], np.where(bar, 255, 0))

    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_OPEN, k, iterations=1)
    alpha = cv2.morphologyEx(alpha, cv2.MORPH_CLOSE, k, iterations=1)
    alpha = cv2.dilate(alpha, k, iterations=1)
    return alpha


def feather_alpha(alpha: np.ndarray, sigma: float = 1.15) -> np.ndarray:
    a = alpha.astype(np.float32)
    a = cv2.GaussianBlur(a, (0, 0), sigmaX=sigma, sigmaY=sigma)
    return np.clip(a, 0, 255).astype(np.uint8)


def main() -> None:
    if len(sys.argv) < 3:
        print(
            "Usage: python tools/extract_garment_design.py <input> <output.png> [meta.json]",
            file=sys.stderr,
        )
        sys.exit(2)
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    meta_path = Path(sys.argv[3]) if len(sys.argv) > 3 else dst.with_suffix(".meta.json")

    if not src.is_file():
        print(f"Not found: {src}", file=sys.stderr)
        sys.exit(1)

    bgr = cv2.imread(str(src), cv2.IMREAD_COLOR)
    if bgr is None:
        print(f"Could not read image: {src}", file=sys.stderr)
        sys.exit(1)

    h, w = bgr.shape[:2]
    alpha = feather_alpha(build_design_alpha(bgr))
    ys, xs = np.where(alpha > 8)
    if len(ys) == 0:
        print("No design pixels found; check thresholds or input image.", file=sys.stderr)
        sys.exit(1)

    pad = 12
    x0 = max(0, int(xs.min()) - pad)
    y0 = max(0, int(ys.min()) - pad)
    x1 = min(w, int(xs.max()) + pad + 1)
    y1 = min(h, int(ys.max()) + pad + 1)

    crop_bgr = bgr[y0:y1, x0:x1]
    crop_a = alpha[y0:y1, x0:x1]
    bgra = cv2.merge([crop_bgr[:, :, 0], crop_bgr[:, :, 1], crop_bgr[:, :, 2], crop_a])
    cv2.imwrite(str(dst), bgra)

    cx = (float(xs.min() + xs.max()) + 1) / 2.0
    cy = (float(ys.min() + ys.max()) + 1) / 2.0
    meta = {
        "source_width": w,
        "source_height": h,
        "crop_rect": {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0},
        "print_center_norm": {"x": cx / w, "y": cy / h},
        "print_bbox_norm": {
            "x0": float(xs.min()) / w,
            "y0": float(ys.min()) / h,
            "x1": float(xs.max() + 1) / w,
            "y1": float(ys.max() + 1) / h,
        },
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print(f"Wrote {dst.resolve()}")
    print(f"Wrote {meta_path.resolve()}")


if __name__ == "__main__":
    main()
