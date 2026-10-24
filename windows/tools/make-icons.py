#!/usr/bin/env python3
"""make-icons.py OUTDIR — the Tin Hat Server icons for Windows, drawn from the Tin Hat app icon (appicon/tinhat.svg).

Pure Python (no image libraries): the hat is 21 flat polygons, rendered with supersampling and written as PNG-in-ICO.
  app.ico                 the program and installer icon (16-256 px)
  tray-running.ico        tray: the hat, with a thin dark outline so it shows on light and dark taskbars
  tray-paused.ico         tray: the hat greyed out, with a pause badge
  tray-attention.ico      tray: the hat with an amber dot (setup not finished, or the server isn't answering)
"""
import struct
import sys
import zlib
from pathlib import Path

# appicon/tinhat.svg: <g transform="translate(-14.384 62.96) scale(1.046)">, viewBox 0 0 512 512, painted in order.
POLYS = [
    ("#cbd3da", "308 40 313 103 373 178 409 258 267 245 114 231 181 139 256 70"),
    ("#cbd3da", "52 218 104 201 152 217 280 231 405 242 465 267 426 294 267 277 85 264"),
    ("#b2bbc4", "52 218 104 201 152 217 280 231 405 242 465 267 413 276 267 252 119 239"),
    ("#8c99a6", "70 216 104 207 123 229"),
    ("#f2f4f6", "52 218 104 201 104 207 70 216 123 229"),
    ("#919fab", "397 242 447 263 413 265"),
    ("#f7f9fb", "308 40 256 70 269 107"),
    ("#dbe0e5", "256 70 181 139 269 107"),
    ("#c6cdd4", "181 139 114 231 267 245"),
    ("#e4e8eb", "181 139 269 107 267 245"),
    ("#a3adb8", "269 107 308 40 309 101 367 178"),
    ("#c1cad2", "269 107 367 178 267 245"),
    ("#98a6b3", "367 178 405 257 267 245"),
    ("#d7e0e8", "308 40 313 103 373 178 409 258 405 257 367 178 309 101"),
    ("#a0abb7", "52 218 114 231 85 264"),
    ("#eaeef1", "114 231 267 245 85 264"),
    ("#c5ced7", "85 264 267 245 267 277"),
    ("#dfe7ed", "267 245 405 257 426 294"),
    ("#a4b3c0", "267 245 426 294 267 277"),
    ("#b7c6d2", "405 257 465 267 426 294"),
    ("#f6fbfb", "405 257 465 267 452 270 408 262"),
]


def _rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def _shapes(size, pad):
    """Polygons in pixel coordinates for an icon of `size`, the hat's bounding box fitted with `pad` px around it."""
    pts = []
    for col, s in POLYS:
        v = [float(x) for x in s.split()]
        p = [(1.046 * v[i] - 14.384, 1.046 * v[i + 1] + 62.96) for i in range(0, len(v), 2)]
        pts.append((_rgb(col), p))
    xs = [x for _, p in pts for x, _ in p]
    ys = [y for _, p in pts for _, y in p]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    scale = (size - 2 * pad) / max(x1 - x0, y1 - y0)
    ox = (size - (x1 - x0) * scale) / 2 - x0 * scale
    oy = (size - (y1 - y0) * scale) / 2 - y0 * scale
    return [(c, [(x * scale + ox, y * scale + oy) for x, y in p]) for c, p in pts]


def _fill(buf, n, poly, color):
    """Scanline-fill one polygon into an n×n RGBA supersample buffer (bytearray)."""
    px = bytes(color) + b"\xff"
    ys = [y for _, y in poly]
    for row in range(max(0, int(min(ys))), min(n, int(max(ys)) + 1)):
        yc = row + 0.5
        xs = []
        for i in range(len(poly)):
            (xa, ya), (xb, yb) = poly[i], poly[(i + 1) % len(poly)]
            if (ya <= yc < yb) or (yb <= yc < ya):
                xs.append(xa + (yc - ya) * (xb - xa) / (yb - ya))
        xs.sort()
        for a, b in zip(xs[0::2], xs[1::2]):
            c0, c1 = max(0, int(a + 0.5)), min(n, int(b + 0.5))
            if c1 > c0:
                o = (row * n + c0) * 4
                buf[o:o + (c1 - c0) * 4] = px * (c1 - c0)


def _circle(buf, n, cx, cy, r, color):
    px = bytes(color) + b"\xff"
    for row in range(max(0, int(cy - r)), min(n, int(cy + r) + 2)):
        dy = row + 0.5 - cy
        if abs(dy) > r:
            continue
        w = (r * r - dy * dy) ** 0.5
        c0, c1 = max(0, int(cx - w + 0.5)), min(n, int(cx + w + 0.5))
        if c1 > c0:
            o = (row * n + c0) * 4
            buf[o:o + (c1 - c0) * 4] = px * (c1 - c0)


def _rect(buf, n, x0, y0, x1, y1, color):
    px = bytes(color) + b"\xff"
    for row in range(max(0, int(y0)), min(n, int(y1))):
        c0, c1 = max(0, int(x0)), min(n, int(x1))
        if c1 > c0:
            o = (row * n + c0) * 4
            buf[o:o + (c1 - c0) * 4] = px * (c1 - c0)


def _downsample(buf, n, s):
    """n×n supersamples → (n/s)×(n/s) pixels, alpha-weighted average (straight alpha out)."""
    size = n // s
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for sy in range(s):
                o = ((y * s + sy) * n + x * s) * 4
                for sx in range(s):
                    al = buf[o + 3]
                    if al:
                        r += buf[o] * al
                        g += buf[o + 1] * al
                        b += buf[o + 2] * al
                        a += al
                    o += 4
            p = (y * size + x) * 4
            if a:
                out[p:p + 4] = bytes((r // a, g // a, b // a, a // (s * s)))
    return out


def render(size, variant):
    s = 8 if size <= 64 else 4
    n = size * s
    buf = bytearray(n * n * 4)
    tray = variant != "app"
    pad = max(0.5, size * (0.02 if tray else 0.06))
    shapes = _shapes(n, pad * s)
    if tray:
        # Outline: the silhouette, grown by ~1 px, in dark slate under the hat.
        grow = max(1.0, size / 24) * s
        outline = (52, 62, 74)
        for _, p in shapes:
            cx = sum(x for x, _ in p) / len(p)
            cy = sum(y for _, y in p) / len(p)
            for dx, dy in ((-grow, 0), (grow, 0), (0, -grow), (0, grow), (-grow, -grow), (grow, grow), (-grow, grow), (grow, -grow)):
                _fill(buf, n, [(x + dx, y + dy) for x, y in p], outline)
            del cx, cy
    for col, p in shapes:
        if variant == "paused":
            g = int(0.3 * col[0] + 0.59 * col[1] + 0.11 * col[2])
            col = (g * 7 // 10 + 40,) * 3
        _fill(buf, n, p, col)
    if variant == "paused":
        r = n * 0.24
        cx, cy = n - r - s * 0.2, n - r - s * 0.2
        _circle(buf, n, cx, cy, r, (40, 46, 54))
        _circle(buf, n, cx, cy, r * 0.82, (250, 250, 250))
        bw, bh = r * 0.26, r * 0.95
        _rect(buf, n, cx - bw * 1.6, cy - bh / 2, cx - bw * 0.6, cy + bh / 2, (40, 46, 54))
        _rect(buf, n, cx + bw * 0.6, cy - bh / 2, cx + bw * 1.6, cy + bh / 2, (40, 46, 54))
    elif variant == "attention":
        r = n * 0.2
        cx, cy = n - r - s * 0.2, n - r - s * 0.2
        _circle(buf, n, cx, cy, r, (40, 46, 54))
        _circle(buf, n, cx, cy, r * 0.78, (245, 166, 35))
    return _downsample(buf, n, s)


def png(size, rgba):
    raw = b"".join(b"\0" + bytes(rgba[y * size * 4:(y + 1) * size * 4]) for y in range(size))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)  # noqa: E731
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def ico(images):
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for size, data in images:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    return head + entries + blobs


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out.mkdir(parents=True, exist_ok=True)
    sets = {"app": [16, 20, 24, 32, 40, 48, 64, 256], "tray-running": [16, 20, 24, 32, 40, 48, 64],
            "tray-paused": [16, 20, 24, 32, 40, 48, 64], "tray-attention": [16, 20, 24, 32, 40, 48, 64]}
    for name, sizes in sets.items():
        variant = "app" if name == "app" else name.split("-", 1)[1]
        imgs = [(sz, png(sz, render(sz, variant))) for sz in sizes]
        (out / f"{name}.ico").write_bytes(ico(imgs))
        (out / f"{name}-{max(sizes)}.png").write_bytes(imgs[-1][1])
        (out / f"{name}-32.png").write_bytes(dict(imgs)[32])
        print(f"{name}.ico ({', '.join(str(s) for s in sizes)})")


if __name__ == "__main__":
    main()
