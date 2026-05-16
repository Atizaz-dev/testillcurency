#!/usr/bin/env python3
"""
Remove a central chest print from a flat-lay product shot.

Uses: print detection mask + dilate, Navier–Stokes inpaint, TELEA on residual
saturation, local-ring BGR match, optional luma lift if the hole is still darker
than the ring, LAB a/b neutralisation, mild high-frequency boost in the hole,
Gaussian feather at the hole boundary (softens the “box” seam), and warm edge
sliver repair on the left/right margins.

Depends: pip install numpy opencv-python-headless

Usage:
  python tools/strip_garment_print.py <input.webp|jpg> <output.png>
  python tools/strip_garment_print.py --refine <already-stripped.png> <output.png>

  --refine: chest ellipse + inpaint + tone/texture fixes when the print is already gone
  but a grey box / harsh seam remains (no ink left to threshold).
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np


def build_detection_mask(bgr: np.ndarray) -> np.ndarray:
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    s = hsv[:, :, 1]

    mask = np.zeros((h, w), np.uint8)
    # Tall rectangular chest prints often reach ~0.17h–0.76h; the old 0.32–0.54 band
    # missed the lower third and left ink + NS-inpaint smears on the fabric.
    y0, y1 = int(h * 0.16), int(h * 0.78)
    x0, x1 = int(w * 0.13), int(w * 0.87)
    m_u = (s[y0:y1, x0:x1] > 14) | (gray[y0:y1, x0:x1] < 192)
    mask[y0:y1, x0:x1] = np.where(m_u, 255, mask[y0:y1, x0:x1])

    # Narrow vertical bridge (low-sat ink inside the art) — full-width slabs over-inpaint
    # and read as a smeary grey patch next to real fabric texture.
    yb0, yb1 = int(h * 0.36), int(h * 0.64)
    xb0, xb1 = int(w * 0.36), int(w * 0.64)
    mask[yb0:yb1, xb0:xb1] = 255

    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k, iterations=2)
    mask = cv2.dilate(mask, k, iterations=2)
    k_big = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k_big, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k, iterations=1)
    k_tall = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 39))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k_tall, iterations=1)
    # Wide dilate eats print fringes without painting a full “chest pill” ellipse.
    k_w = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))
    mask = cv2.dilate(mask, k_w, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k_w, iterations=1)
    return mask


def build_mask(bgr: np.ndarray) -> np.ndarray:
    return build_detection_mask(bgr)


def _reference_fabric_donor(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    h, w = mask.shape[:2]
    sel = np.zeros((h, w), dtype=bool)
    regions = (
        (slice(int(h * 0.48), int(h * 0.62)), slice(int(w * 0.06), int(w * 0.14))),
        (slice(int(h * 0.48), int(h * 0.62)), slice(int(w * 0.86), int(w * 0.95))),
    )
    for r0, c0 in regions:
        sel[r0, c0] = True
    donor = sel & (mask == 0)
    hole = mask > 127
    if donor.sum() < 200:
        inv = (mask == 0).astype(np.uint8) * 255
        dist = cv2.distanceTransform(inv, cv2.DIST_L2, 5)
        yy, xx = np.mgrid[0:h, 0:w]
        torso = (
            (yy > h * 0.28)
            & (yy < h * 0.88)
            & (xx > w * 0.08)
            & (xx < w * 0.92)
        )
        donor = (dist >= 8) & (dist <= 50) & (mask == 0) & torso
    return donor, hole


def match_bgr_mean_to_reference(
    inp: np.ndarray, mask: np.ndarray, strength: float = 0.78
) -> np.ndarray:
    donor, hole = _reference_fabric_donor(mask)
    if not np.any(donor) or not np.any(hole):
        return inp
    dm = inp[donor].mean(0, dtype=np.float64)
    hm = inp[hole].mean(0, dtype=np.float64)
    out = inp.astype(np.float32)
    out[hole] += (dm - hm) * strength
    return np.clip(out, 0, 255).astype(np.uint8)


def _local_torso_ring(mask: np.ndarray, dilate_iters: int = 6) -> np.ndarray:
    h, w = mask.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    torso = (
        (yy > h * 0.22)
        & (yy < h * 0.92)
        & (xx > w * 0.06)
        & (xx < w * 0.94)
    )
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    outer = cv2.dilate(mask, k, iterations=dilate_iters)
    ring_u8 = cv2.subtract(outer, mask)
    return (ring_u8 > 0) & torso


def match_bgr_to_local_ring(
    inp: np.ndarray,
    mask: np.ndarray,
    dilate_iters: int = 6,
    strength: float = 0.82,
) -> np.ndarray:
    """Match hole mean BGR to a ring just outside the mask (torso-clipped)."""
    ring = _local_torso_ring(mask, dilate_iters=dilate_iters)
    hole = mask > 127
    if ring.sum() < 400 or not np.any(hole):
        return match_bgr_mean_to_reference(inp, mask, strength=strength)
    dm = inp[ring].mean(0, dtype=np.float64)
    hm = inp[hole].mean(0, dtype=np.float64)
    out = inp.astype(np.float32)
    out[hole] += (dm - hm) * strength
    return np.clip(out, 0, 255).astype(np.uint8)


def inpaint_residual_saturation(
    inp: np.ndarray,
    limit_mask: np.ndarray,
    s_thresh: int = 9,
    inpaint_radius: int = 10,
    *,
    ns: bool = False,
) -> np.ndarray:
    """Touch-up inpaint on pixels that still carry print colour inside the chest."""
    hsv = cv2.cvtColor(inp, cv2.COLOR_BGR2HSV)
    sub = ((hsv[:, :, 1] > s_thresh).astype(np.uint8)) * 255
    sub = cv2.bitwise_and(sub, limit_mask)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    sub = cv2.dilate(sub, k, iterations=2 if ns else 3)
    if int(sub.sum()) < 300:
        return inp
    flags = cv2.INPAINT_NS if ns else cv2.INPAINT_TELEA
    return cv2.inpaint(inp, sub, inpaintRadius=inpaint_radius, flags=flags)


def _depth_inside_hole(mask: np.ndarray) -> np.ndarray:
    """Distance from each hole pixel to the nearest pixel outside the mask (0 outside)."""
    fg = (mask > 127).astype(np.uint8)
    return cv2.distanceTransform(fg, cv2.DIST_L2, 5)


def feather_hole_boundary(
    out: np.ndarray,
    mask: np.ndarray,
    feather: float = 24.0,
    mix: float = 0.48,
) -> np.ndarray:
    """Soften the hard inpaint seam by blending a Gaussian-smoothed copy near the hole edge."""
    hole = mask > 127
    if not np.any(hole):
        return out
    d = _depth_inside_hole(mask).astype(np.float32)
    t = np.clip(d / feather, 0.0, 1.0)
    edge_w = (1.0 - t) * mix
    smooth = cv2.GaussianBlur(out, (0, 0), sigmaX=5.0, sigmaY=5.0)
    base = out.astype(np.float32)
    sm = smooth.astype(np.float32)
    ew = edge_w[..., np.newaxis]
    blended = base * (1.0 - ew) + sm * ew
    out2 = out.copy().astype(np.float32)
    out2[hole] = blended[hole]
    return np.clip(out2, 0, 255).astype(np.uint8)


def boost_hole_detail(
    out: np.ndarray,
    mask: np.ndarray,
    sigma: float = 5.0,
    gain: float = 0.24,
) -> np.ndarray:
    """Restore a bit of high-frequency energy inside the hole (NS inpaint is too flat)."""
    hole = mask > 127
    if not np.any(hole):
        return out
    blur = cv2.GaussianBlur(out, (0, 0), sigma).astype(np.float32)
    base = out.astype(np.float32)
    detail = base - blur
    d = _depth_inside_hole(mask).astype(np.float32)
    ramp = np.clip(d / 12.0, 0.0, 1.0)[..., np.newaxis]
    boosted = base + detail * (gain * ramp)
    out2 = base.copy()
    out2[hole] = boosted[hole]
    return np.clip(out2, 0, 255).astype(np.uint8)


def align_hole_luma_to_ring(
    out: np.ndarray,
    mask: np.ndarray,
    max_lift: float = 10.0,
) -> np.ndarray:
    """If the hole is still darker than the local ring, lift L slightly (reduces grey box)."""
    ring = _local_torso_ring(mask, dilate_iters=8)
    hole = mask > 127
    if ring.sum() < 400 or not np.any(hole):
        return out
    gray = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY).astype(np.float32)
    r_m = float(gray[ring].mean())
    h_m = float(gray[hole].mean())
    delta = r_m - h_m
    if delta <= 0.5:
        return out
    delta = min(delta, max_lift)
    lab = cv2.cvtColor(out, cv2.COLOR_BGR2LAB).astype(np.float32)
    lab[hole, 0] = np.clip(lab[hole, 0] + delta * 0.92, 0, 255)
    return cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)


def imprint_fabric_grain(out: np.ndarray, mask: np.ndarray, scale: float = 0.38) -> np.ndarray:
    """
    NS inpaint flattens micro-contrast; add low-amplitude, donor-matched noise in the
    hole so the chest reads closer to real knit/fleece (reduces the grey “smear”).
    """
    donor, hole = _reference_fabric_donor(mask)
    if donor.sum() < 200 or not np.any(hole):
        return out
    sub = out.astype(np.float32)
    h, w = out.shape[:2]
    seed = (h * 1315423911 + w * 2654435761 + int(out[0, 0, 0])) & 0x7FFFFFFF
    prng = np.random.default_rng(seed)
    for c in range(3):
        ch = sub[:, :, c]
        std = float(np.std(ch[donor]))
        std = max(std, 1.2)
        rng = prng.standard_normal((h, w)).astype(np.float32) * (std * scale)
        rng = cv2.GaussianBlur(rng, (0, 0), sigmaX=1.1, sigmaY=1.1)
        ch_h = ch[hole] + rng[hole]
        ch = ch.copy()
        ch[hole] = ch_h
        sub[:, :, c] = ch
    return np.clip(sub, 0, 255).astype(np.uint8)


def repair_warm_edge_slivers(
    bgr: np.ndarray,
    margin_frac: float = 0.055,
    min_col: int = 3,
) -> np.ndarray:
    """
    Kill thin tan/yellow fringes on the left/right garment margin (compression / matting).
    """
    h, w = bgr.shape[:2]
    m = max(min_col, int(w * margin_frac))
    b, g, r = cv2.split(bgr)
    bi, gi, ri = b.astype(np.int16), g.astype(np.int16), r.astype(np.int16)
    warm = (ri - bi > 10) & (gi - bi > 8) & (ri > 185) & (gi > 185)
    mask = np.zeros((h, w), np.uint8)
    mask[:, :m] = 255
    mask[:, w - m :] = 255
    sub = (warm.astype(np.uint8) * 255) & mask
    sub = cv2.morphologyEx(
        sub, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (2, 5))
    )
    if int(sub.sum()) < 80:
        return bgr
    return cv2.inpaint(bgr, sub, inpaintRadius=4, flags=cv2.INPAINT_TELEA)


def pull_ab_to_reference(out: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Reduce blue/yellow cast in the hole (common NS inpaint + JPEG residue)."""
    ring = _local_torso_ring(mask, dilate_iters=6)
    donor, hole = _reference_fabric_donor(mask)
    if not np.any(hole):
        return out
    lab = cv2.cvtColor(out, cv2.COLOR_BGR2LAB).astype(np.float32)
    ref = ring if ring.sum() >= 400 else donor
    if not np.any(ref):
        return out
    ma = float(np.median(lab[ref, 1]))
    mb = float(np.median(lab[ref, 2]))
    h = mask > 127
    lab[h, 1] = lab[h, 1] * 0.22 + ma * 0.78
    lab[h, 2] = lab[h, 2] * 0.22 + mb * 0.78
    return cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)


def heal_chain(out: np.ndarray, mask: np.ndarray) -> np.ndarray:
    dil = np.ones((3, 3), np.uint8)
    limit = cv2.dilate(mask, dil, iterations=22)
    # NS avoids the blocky TELEA look on large residual islands.
    out = inpaint_residual_saturation(
        out, limit_mask=limit, s_thresh=7, inpaint_radius=9, ns=True
    )
    out = match_bgr_to_local_ring(out, mask, dilate_iters=8, strength=0.85)
    out = align_hole_luma_to_ring(out, mask)
    out = pull_ab_to_reference(out, mask)
    limit2 = cv2.dilate(mask, dil, iterations=26)
    out = inpaint_residual_saturation(
        out, limit_mask=limit2, s_thresh=5, inpaint_radius=7, ns=True
    )
    out = match_bgr_to_local_ring(out, mask, dilate_iters=8, strength=0.65)
    out = pull_ab_to_reference(out, mask)
    out = boost_hole_detail(out, mask)
    out = feather_hole_boundary(out, mask)
    out = imprint_fabric_grain(out, mask)
    out = repair_warm_edge_slivers(out)
    return out


def strip_print(bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mask = build_mask(bgr)
    out = cv2.inpaint(bgr, mask, inpaintRadius=20, flags=cv2.INPAINT_NS)
    out = heal_chain(out, mask)
    return out, mask


def refine_blank_chest(bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Fix an already stripped flat-lay without a second full inpaint (which can read as
    a new grey “pill”). Uses a chest ellipse only to define where to match tone/texture.
    """
    h, w = bgr.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    cx, cy = w // 2, int(h * 0.44)
    ax, ay = max(10, int(w * 0.34)), max(8, int(h * 0.115))
    cv2.ellipse(mask, (cx, cy), (ax, ay), 0, 0, 360, 255, thickness=-1)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    mask = cv2.dilate(mask, k, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k, iterations=1)
    out = heal_chain(bgr.copy(), mask)
    return out, mask


def main() -> None:
    argv = sys.argv[1:]
    refine = False
    if argv and argv[0] == "--refine":
        refine = True
        argv = argv[1:]
    if len(argv) < 2:
        print(
            "Usage: python tools/strip_garment_print.py [--refine] <input> <output.png>",
            file=sys.stderr,
        )
        sys.exit(2)
    src = Path(argv[0])
    dst = Path(argv[1])
    if not src.is_file():
        print(f"Not found: {src}", file=sys.stderr)
        sys.exit(1)

    bgr = cv2.imread(str(src), cv2.IMREAD_COLOR)
    if bgr is None:
        print(f"Could not read image: {src}", file=sys.stderr)
        sys.exit(1)

    if refine:
        out, _mask = refine_blank_chest(bgr)
    else:
        out, _mask = strip_print(bgr)
    cv2.imwrite(str(dst), out)
    print(f"Wrote {dst.resolve()}")


if __name__ == "__main__":
    main()
