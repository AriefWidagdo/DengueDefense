"""Image validation and EXIF normalization for capture uploads.

Limits (enforced before any GPU dispatch):
- media allowlist: real JPEG or PNG content only (magic bytes plus decode)
- decoded dimensions: at most 16,000,000 pixels
- file size: at most 12 MiB
The submitted original is preserved byte-for-byte; the inference image is
EXIF-normalized and its hash plus every transformation are recorded.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
ALLOWED_PIL_FORMATS = {"JPEG", "PNG"}
# The existing deployed ObjectCounter rejects inference payloads over 12 MiB.
COUNTER_MAX_IMAGE_BYTES = 12 * 1024 * 1024


@dataclass(frozen=True)
class InspectedImage:
    media_type: str  # image/jpeg | image/png
    width: int
    height: int
    sha256: str
    inference_bytes: bytes
    inference_media_type: str  # image/png | image/jpeg
    inference_sha256: str
    exif_orientation: int | None
    transformations: list[dict] = field(default_factory=list)


@dataclass(frozen=True)
class ImageLimits:
    max_bytes: int = 12 * 1024 * 1024
    max_pixels: int = 16_000_000
    max_inference_bytes: int = COUNTER_MAX_IMAGE_BYTES


def inference_storage_key(upload_id: str, inspected: InspectedImage) -> str:
    suffix = "png" if inspected.inference_media_type == "image/png" else "jpg"
    return f"uploads/{upload_id}/inference.{suffix}"


def _fail(status_code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail=detail)


def inspect_image(data: bytes, limits: ImageLimits | None = None) -> InspectedImage:
    limits = limits or ImageLimits()
    if not data:
        raise _fail(400, "Empty image payload")
    if len(data) > limits.max_bytes:
        raise _fail(413, "Image exceeds the 12 MiB upload limit")
    if data.startswith(PNG_MAGIC):
        pil_format, media_type = "PNG", "image/png"
    elif data.startswith(JPEG_MAGIC):
        pil_format, media_type = "JPEG", "image/jpeg"
    else:
        raise _fail(415, "Unsupported media type: only JPEG and PNG are accepted")

    try:
        with Image.open(io.BytesIO(data)) as probe:
            if probe.format != pil_format:
                raise _fail(415, "Unsupported media type: only JPEG and PNG are accepted")
            width, height = probe.size
            if width * height > limits.max_pixels:
                raise _fail(413, "Image exceeds the 16 megapixel limit")
            probe.verify()  # structure check without full decode
        with Image.open(io.BytesIO(data)) as source:
            if source.width * source.height > limits.max_pixels:
                raise _fail(413, "Image exceeds the 16 megapixel limit")
            exif = source.getexif()
            orientation = exif.get(274) if exif is not None else None  # 274 = EXIF orientation
            normalized = ImageOps.exif_transpose(source)
            if normalized is None:
                normalized = source
            rgb = normalized.convert("RGB")
            rgb.load()
    except UnidentifiedImageError as error:
        raise _fail(415, "Unsupported media type: only JPEG and PNG are accepted") from error
    except HTTPException:
        raise
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise _fail(400, f"Invalid image content: {error}") from error

    transformations: list[dict] = [{"step": "preserve_original", "sha256": hashlib.sha256(data).hexdigest()}]
    if orientation not in (None, 1):
        transformations.append({"step": "exif_transpose", "from_orientation": int(orientation)})
    else:
        transformations.append({"step": "exif_transpose", "applied": False})
    buffer = io.BytesIO()
    try:
        rgb.save(buffer, format="PNG")
    except (OSError, ValueError) as error:
        raise _fail(400, "The photo could not be normalized for counting") from error
    inference_bytes = buffer.getvalue()
    inference_media_type = "image/png"
    if len(inference_bytes) <= limits.max_inference_bytes:
        transformations.append({"step": "convert_rgb_png", "width": rgb.width, "height": rgb.height})
    else:
        # A small phone JPEG can expand past the counter's 12 MiB limit as a
        # lossless PNG. Preserve the submitted original and explicitly record
        # a high-quality RGB JPEG conversion if it keeps the input under cap.
        # Never silently resize or submit an oversized payload to the GPU.
        inference_media_type = "image/jpeg"
        for quality in (95, 90, 85, 80):
            buffer = io.BytesIO()
            try:
                rgb.save(buffer, format="JPEG", quality=quality, subsampling=0, optimize=False)
            except (OSError, ValueError) as error:
                raise _fail(400, "The photo could not be normalized for counting") from error
            inference_bytes = buffer.getvalue()
            if len(inference_bytes) <= limits.max_inference_bytes:
                transformations.append({
                    "step": "convert_rgb_jpeg", "width": rgb.width, "height": rgb.height,
                    "quality": quality, "subsampling": 0, "lossy": True,
                })
                break
        else:
            raise _fail(413, "The normalized photo is too large for the counter. Use a smaller photo or crop it, keeping the QR and collection surface visible.")

    return InspectedImage(
        media_type=media_type,
        width=width,
        height=height,
        sha256=hashlib.sha256(data).hexdigest(),
        inference_bytes=inference_bytes,
        inference_media_type=inference_media_type,
        inference_sha256=hashlib.sha256(inference_bytes).hexdigest(),
        exif_orientation=orientation,
        transformations=transformations,
    )