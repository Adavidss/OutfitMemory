#!/usr/bin/env python3
"""
generate_icons.py — renders the OutfitMemory app icons (PNG) from the same
design as icons/icon.svg: violet→pink gradient, white camera, heart lens.

Pure numpy SDF renderer (no Pillow/ImageMagick needed):
    python3 scripts/generate_icons.py

Outputs into icons/:
    icon-512.png            rounded, transparent corners (manifest "any")
    icon-192.png            rounded, transparent corners
    favicon-32.png          rounded, transparent corners
    icon-maskable-512.png   full-bleed bg, shrunken art (Android maskable)
    apple-touch-icon.png    180px full-bleed (iOS rounds it itself)
"""

import os
import struct
import sys
import zlib

try:
    import numpy as np
except ImportError:
    sys.exit("This script needs numpy: python3 -m pip install numpy")

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")

GRAD_A = (0x7C, 0x5C, 0xFF)  # violet
GRAD_B = (0xFF, 0x7A, 0xA2)  # pink


def write_png(path, rgba):
    """rgba: (H, W, 4) uint8 → PNG file (no deps)."""
    h, w = rgba.shape[:2]

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


# ---------- signed distance fields (coords in 0..1 icon space) ----------

def sd_rounded_rect(X, Y, cx, cy, w, h, r):
    qx = np.abs(X - cx) - (w / 2 - r)
    qy = np.abs(Y - cy) - (h / 2 - r)
    outside = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
    inside = np.minimum(np.maximum(qx, qy), 0)
    return outside + inside - r


def sd_heart(X, Y, cx, cy, a):
    """Classic construction: 45°-rotated square (diamond) ∪ two circles
    centered on the upper edge midpoints. Point-down heart."""
    u, v = X - cx, Y - cy
    diamond = (np.abs(u) + np.abs(v) - a) / np.sqrt(2)
    r = a / np.sqrt(2)
    c1 = np.hypot(u + a / 2, v + a / 2) - r
    c2 = np.hypot(u - a / 2, v + a / 2) - r
    return np.minimum(diamond, np.minimum(c1, c2))


def coverage(sdf, px):
    """SDF → antialiased coverage in [0,1]."""
    return np.clip(0.5 - sdf / px, 0.0, 1.0)


# ---------- render ----------

def render(size, ss, rounded_bg, fg_scale):
    n = size * ss
    ys, xs = np.mgrid[0:n, 0:n]
    X = (xs + 0.5) / n
    Y = (ys + 0.5) / n
    px = 1.0 / n

    # Diagonal gradient + soft top-left glow
    t = np.clip((X + Y) / 2, 0, 1)[..., None]
    a = np.array(GRAD_A, dtype=np.float64) / 255
    b = np.array(GRAD_B, dtype=np.float64) / 255
    bg = a + (b - a) * t
    glow = np.clip(1 - np.hypot(X - 0.3, Y - 0.22) / 0.95, 0, 1) ** 2 * 0.10
    bg = np.clip(bg + glow[..., None], 0, 1)

    bg_alpha = coverage(sd_rounded_rect(X, Y, 0.5, 0.5, 1, 1, 0.235), px) if rounded_bg else np.ones_like(X)

    # Foreground sampled in scaled coords (fg_scale < 1 shrinks the art)
    Xf = 0.5 + (X - 0.5) / fg_scale
    Yf = 0.5 + (Y - 0.5) / fg_scale
    body = sd_rounded_rect(Xf, Yf, 0.5, 0.565, 0.60, 0.42, 0.10)
    bump = sd_rounded_rect(Xf, Yf, 0.5, 0.375, 0.24, 0.12, 0.05)
    camera = np.minimum(body, bump)
    heart = sd_heart(Xf, Yf, 0.5, 0.568, 0.135)
    fg = np.maximum(camera, -heart)  # camera minus heart hole
    fg_alpha = coverage(fg, px * 1.5)[..., None]

    color = bg * (1 - fg_alpha) + 1.0 * fg_alpha  # white art over gradient
    rgba = np.dstack([color, bg_alpha[..., None]])

    # Supersample → box downsample
    rgba = rgba.reshape(size, ss, size, ss, 4).mean(axis=(1, 3))
    return (rgba * 255 + 0.5).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ("icon-512.png",          512, 2, True,  1.00),
        ("icon-192.png",          192, 4, True,  1.00),
        ("favicon-32.png",         32, 8, True,  1.10),
        ("icon-maskable-512.png", 512, 2, False, 0.72),
        ("apple-touch-icon.png",  180, 4, False, 0.94),
    ]
    for name, size, ss, rounded, scale in jobs:
        path = os.path.join(OUT, name)
        write_png(path, render(size, ss, rounded, scale))
        print(f"  wrote {name} ({size}x{size})")


if __name__ == "__main__":
    main()
