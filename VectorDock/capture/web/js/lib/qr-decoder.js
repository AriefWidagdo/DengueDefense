/**
 * Photo QR decoding (browser path).
 *
 * Decodes QR codes from the actual selected/captured photo with the locally
 * vendored jsqr 1.4.0 (see vendor/README.md). SAM3 is never used for QR
 * decoding and BarcodeDetector is not a required path.
 *
 * The decoder reads the photo's raw pixels and applies the EXIF orientation
 * itself (see js/lib/exif.js), so the same tested transpose code runs in the
 * browser and in the offline fixture tests. Large photos are downscaled
 * before scanning; the original file is never modified.
 */

import { readExifOrientation, applyExifOrientation } from "./exif.js";
import { scanQrCodes } from "./qr-scan.js";
import { inspectPhotoFile } from "./image-header.js";

const SCAN_MAX_EDGE = 1400; // decode scale; QR labels stay decodable well below this

function requireJsQr() {
  const decoder = globalThis.jsQR;
  if (typeof decoder !== "function") {
    throw new Error("The vendored QR decoder (vendor/jsQR.js) failed to load.");
  }
  return decoder;
}

/**
 * Decode every QR code in one RGBA image. Returns the distinct decoded
 * strings in discovery order.
 */
export function scanAllQrCodes(data, width, height) {
  const decoder = requireJsQr();
  return scanQrCodes(data, width, height, (pixels, w, h) => {
    const result = decoder(pixels, w, h, { inversionAttempts: "dontInvert" });
    return result ? { data: result.data, location: result.location } : null;
  });
}

/**
 * Decode the container QR payloads from one photo File/Blob.
 * Browser-only (needs createImageBitmap and a 2D canvas).
 * Returns the decoded payload strings (may be empty when nothing is readable).
 */
export async function decodePhotoQrPayloads(blob, inspected = null) {
  const { bytes } = inspected || await inspectPhotoFile(blob);
  const orientation = readExifOrientation(bytes);
  const bitmap = await createImageBitmap(blob, { imageOrientation: "none" });
  try {
    const scale = Math.min(1, SCAN_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const normalized = applyExifOrientation(image.data, image.width, image.height, orientation);
    return scanAllQrCodes(normalized.data, normalized.width, normalized.height);
  } finally {
    bitmap.close();
  }
}
