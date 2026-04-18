#!/usr/bin/env python3
"""Build a 6x10 sprite atlas at 96x96 per cell from 60 source frames.
Source frames are 288x288 RGBA; downscaled 3x with LANCZOS, then
palette-quantized (FASTOCTREE — единственный метод, поддерживающий
RGBA-вход) до ~240KB. Usage: python build_atlas.py <deco-dir>."""
import sys, os
from PIL import Image

FRAMES, COLS, ROWS, CELL = 60, 6, 10, 96

def build(deco_dir):
    atlas = Image.new("RGBA", (COLS * CELL, ROWS * CELL), (0, 0, 0, 0))
    for i in range(FRAMES):
        src = Image.open(os.path.join(deco_dir, f"frame_{i:02d}.png")).convert("RGBA")
        src = src.resize((CELL, CELL), Image.LANCZOS)
        col, row = i % COLS, i // COLS
        atlas.paste(src, (col * CELL, row * CELL), src)
    out = atlas.quantize(colors=255, method=Image.Quantize.FASTOCTREE).convert("RGBA")
    out.save(os.path.join(deco_dir, "atlas.png"), optimize=True)
    size = os.path.getsize(os.path.join(deco_dir, "atlas.png"))
    print(f"atlas: {COLS*CELL}x{ROWS*CELL} {size} bytes")

if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else ".")
