/**
 * Multi-QR scan strategy (pure, runtime-independent).
 *
 * jsQR decodes at most one QR per pass and its locator can fail when two
 * codes share the frame. The scan therefore runs in two bounded stages:
 * 1. full-frame decode, masking each found code and rescanning;
 * 2. a bounded grid of overlapping tiles, each decoded with masking.
 * Two decoded strings need not be two container IDs. A map URL must not
 * cause the scanner to stop before a conflicting container ID is found.
 * The caller supplies the actual decoder callback, so the browser and the
 * offline fixture tests run the identical scan logic.
 */

const MAX_FULL_PASSES = 8;
const MAX_TILE_PASSES = 3;
const TILE_FRACTION = 0.55;
const MASK_MARGIN = 12;

export function cropRegion(source, sourceWidth, x0, y0, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const start = ((y0 + y) * sourceWidth + x0) * 4;
    out.set(source.subarray(start, start + w * 4), y * w * 4);
  }
  return out;
}

function maskLocation(pixels, width, height, location) {
  const left = Math.max(0, Math.min(location.topLeftCorner.x, location.bottomLeftCorner.x) - MASK_MARGIN);
  const right = Math.min(width, Math.max(location.topRightCorner.x, location.bottomRightCorner.x) + MASK_MARGIN);
  const top = Math.max(0, Math.min(location.topLeftCorner.y, location.topRightCorner.y) - MASK_MARGIN);
  const bottom = Math.min(height, Math.max(location.bottomLeftCorner.y, location.bottomRightCorner.y) + MASK_MARGIN);
  for (let y = Math.floor(top); y < bottom; y += 1) {
    for (let x = Math.floor(left); x < right; x += 1) {
      const index = (y * width + x) * 4;
      pixels[index] = 255;
      pixels[index + 1] = 255;
      pixels[index + 2] = 255;
    }
  }
}

/**
 * Scan one image for QR payloads.
 * `decode(data, width, height)` returns `{ data, location }` or null.
 * Returns distinct decoded strings in discovery order.
 */
export function scanQrCodes(source, width, height, decode) {
  const found = [];
  const seen = new Set();
  const record = (result) => {
    if (result && result.data && !seen.has(result.data)) {
      seen.add(result.data);
      found.push(result.data);
    }
    return result;
  };

  // Stage 1: full frame with masking.
  let pixels = new Uint8ClampedArray(source);
  for (let pass = 0; pass < MAX_FULL_PASSES; pass += 1) {
    const result = record(decode(pixels, width, height));
    if (!result) {
      break;
    }
    maskLocation(pixels, width, height, result.location);
  }

  // Stage 2: scan the bounded tile grid even when unrelated QR payloads
  // were found. Payload count is not evidence of container-ID agreement.
  {
    const tileWidth = Math.max(1, Math.round(width * TILE_FRACTION));
    const tileHeight = Math.max(1, Math.round(height * TILE_FRACTION));
    const start_xs = [...new Set([0, Math.floor((width - tileWidth) / 2), Math.max(0, width - tileWidth)])];
    const start_ys = [...new Set([0, Math.floor((height - tileHeight) / 2), Math.max(0, height - tileHeight)])];
    for (const x0 of start_xs) {
      for (const y0 of start_ys) {
        const tile = cropRegion(source, width, x0, y0, tileWidth, tileHeight);
        for (let pass = 0; pass < MAX_TILE_PASSES; pass += 1) {
          const result = record(decode(tile, tileWidth, tileHeight));
          if (!result) {
            break;
          }
          maskLocation(tile, tileWidth, tileHeight, result.location);
        }
      }
    }
  }
  return found;
}
