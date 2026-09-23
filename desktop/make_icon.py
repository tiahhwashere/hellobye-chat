#!/usr/bin/env python3
"""Build the HelloBye desktop app icon from the website favicon.

Source: uploads/favicon.jpg (the same image used as the website favicon).
Outputs:
  desktop/assets/icon.png  -> 1024x1024 PNG (used on non-Windows + as source)
  desktop/assets/icon.ico  -> multi-size Windows icon (16..256)
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "uploads", "favicon.jpg")
OUT_PNG = os.path.join(HERE, "assets", "icon.png")
OUT_ICO = os.path.join(HERE, "assets", "icon.ico")

# Windows .ico sizes (standard set electron-builder / Windows expect).
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

def main():
    img = Image.open(SRC).convert("RGBA")
    # Square-crop (favicon is already square, but be safe).
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))

    # Master 1024x1024 PNG.
    master = img.resize((1024, 1024), Image.LANCZOS)
    master.save(OUT_PNG, "PNG")
    print("wrote", OUT_PNG, master.size)

    # Multi-size ICO. Build each size explicitly for crisp small icons.
    frames = [img.resize((s, s), Image.LANCZOS) for s in ICO_SIZES]
    frames[-1].save(OUT_ICO, format="ICO",
                    sizes=[(s, s) for s in ICO_SIZES],
                    append_images=frames[:-1])
    print("wrote", OUT_ICO, os.path.getsize(OUT_ICO), "bytes")

if __name__ == "__main__":
    main()
