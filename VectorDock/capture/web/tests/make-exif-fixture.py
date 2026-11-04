"""Generates the EXIF-rotated JPEG QR fixture.

Run from VectorDock/capture/web with the backend virtualenv (Pillow):
    ../backend/.venv/Scripts/python.exe tests/make-exif-fixture.py

The fixture is a real photo-like JPEG whose EXIF orientation tag is 6: the
embedded QR decodes only after the 90-degree clockwise normalization that
js/lib/exif.js performs before decoding.
"""

import io
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
WEB = HERE.parent


def main() -> int:
    source = HERE / "fixtures" / "photo-qr-token.png"
    if not source.exists():
        print("run tests/make-fixtures.mjs first", file=sys.stderr)
        return 1
    out = HERE / "fixtures" / "photo-qr-token-exif6.jpg"

    with Image.open(source) as image:
        rgb = image.convert("RGB")
        # Store the photo rotated 90 degrees counter-clockwise and mark it
        # with EXIF orientation 6 (rotate 90 CW to display). The QR becomes
        # readable only after normalization.
        rotated = rgb.transpose(Image.ROTATE_90)
        exif = Image.Exif()
        exif[274] = 6  # orientation tag
        rotated.save(out, format="JPEG", quality=90, exif=exif)

    with Image.open(out) as check:
        print(f"wrote {out.name}: size={check.size} orientation={check.getexif().get(274)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())