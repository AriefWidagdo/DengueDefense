/** Inspect JPEG/PNG dimensions before an image decoder allocates pixels. */
export const MAX_PHOTO_PIXELS = 16_000_000;
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

export class PhotoValidationError extends Error {}

export function imageDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height, format;
  if (bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)
      && view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) {
    width = view.getUint32(16); height = view.getUint32(20); format = "png";
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2;
    while (pos < bytes.length) {
      if (bytes[pos++] !== 0xff) break;
      while (pos < bytes.length && bytes[pos] === 0xff) pos++;
      if (pos >= bytes.length) break;
      const marker = bytes[pos++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (pos + 2 > bytes.length) break;
      const length = view.getUint16(pos);
      if (length < 2 || pos + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 8) break;
        height = view.getUint16(pos + 3); width = view.getUint16(pos + 5); format = "jpeg";
        break;
      }
      pos += length;
    }
  }
  if (!width || !height) throw new PhotoValidationError("The photo has no valid JPEG/PNG dimension header. Retake it as JPEG or PNG.");
  if (width * height > MAX_PHOTO_PIXELS) throw new PhotoValidationError("The photo exceeds 16 megapixels. Reduce the camera resolution and retake it.");
  return { width, height, format };
}

export async function inspectPhotoFile(blob) {
  if (blob.size > MAX_PHOTO_BYTES) throw new PhotoValidationError("The photo is larger than 12 MiB. Reduce the camera resolution and retake it.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { ...imageDimensions(bytes), bytes };
}
