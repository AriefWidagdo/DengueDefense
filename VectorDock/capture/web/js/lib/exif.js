/**
 * EXIF orientation handling for photo QR decoding.
 *
 * The browser decode path reads the photo's raw pixels and applies the
 * EXIF orientation itself (createImageBitmap is called with
 * imageOrientation: "none"), so the same tested transpose code runs in the
 * browser and in the offline fixture tests.
 */

/**
 * Read the EXIF orientation (tag 0x0112) from JPEG bytes.
 * Returns 1-8, or 1 when absent/not a JPEG.
 */
export function readExifOrientation(bytes) {
  if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes)) {
    return 1;
  }
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 4 || view[0] !== 0xff || view[1] !== 0xd8) {
    return 1;
  }
  let offset = 2;
  while (offset + 4 <= view.length) {
    if (view[offset] !== 0xff) {
      return 1; // desynchronized; give up rather than guess
    }
    const marker = view[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = (view[offset + 2] << 8) | view[offset + 3];
    if (marker === 0xe1 && offset + 4 + length <= view.length) {
      // APP1: check the "Exif\0\0" header
      const headerOffset = offset + 4;
      const header = String.fromCharCode(...view.slice(headerOffset, headerOffset + 6));
      if (header !== "Exif\u0000\u0000") {
        offset += 2 + length;
        continue;
      }
      const tiff = headerOffset + 6;
      if (tiff + 8 > view.length) {
        return 1;
      }
      const little = view[tiff] === 0x49 && view[tiff + 1] === 0x4d;
      const read16 = (position) => little
        ? view[position] | (view[position + 1] << 8)
        : (view[position] << 8) | view[position + 1];
      const read32 = (position) => little
        ? (view[position] | (view[position + 1] << 8) | (view[position + 2] << 16) | (view[position + 3] << 24)) >>> 0
        : ((view[position] << 24) | (view[position + 1] << 16) | (view[position + 2] << 8) | view[position + 3]) >>> 0;
      const ifdOffset = tiff + read32(tiff + 4);
      if (ifdOffset + 2 > view.length) {
        return 1;
      }
      const entryCount = read16(ifdOffset);
      for (let i = 0; i < entryCount; i += 1) {
        const entry = ifdOffset + 2 + i * 12;
        if (entry + 12 > view.length) {
          return 1;
        }
        const tag = read16(entry);
        if (tag === 0x0112) {
          const orientation = read16(entry + 8);
          return orientation >= 1 && orientation <= 8 ? orientation : 1;
        }
      }
      return 1;
    }
    if (marker === 0xda) {
      return 1; // start of scan; orientation must have appeared before this
    }
    offset += 2 + length;
  }
  return 1;
}

function transpose(data, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const to = (x * height + y) * 4;
      out[to] = data[from];
      out[to + 1] = data[from + 1];
      out[to + 2] = data[from + 2];
      out[to + 3] = data[from + 3];
    }
  }
  return out;
}

function rotate180(data) {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const j = data.length - 4 - i;
    out[i] = data[j];
    out[i + 1] = data[j + 1];
    out[i + 2] = data[j + 2];
    out[i + 3] = data[j + 3];
  }
  return out;
}

function flipHorizontal(data, width, height) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const to = (y * width + (width - 1 - x)) * 4;
      out[to] = data[from];
      out[to + 1] = data[from + 1];
      out[to + 2] = data[from + 2];
      out[to + 3] = data[from + 3];
    }
  }
  return out;
}

function flipVertical(data, width, height) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    const fromRow = y * width * 4;
    const toRow = (height - 1 - y) * width * 4;
    out.set(data.slice(fromRow, fromRow + width * 4), toRow);
  }
  return out;
}

/**
 * Apply an EXIF orientation (2-8) to RGBA pixel data. Orientation 1 returns
 * the data unchanged. Rotations swap width and height for orientations 5-8.
 */
export function applyExifOrientation(data, width, height, orientation) {
  if (!orientation || orientation === 1) {
    return { data, width, height };
  }
  switch (orientation) {
    case 2:
      return { data: flipHorizontal(data, width, height), width, height };
    case 3:
      return { data: rotate180(data), width, height };
    case 4:
      return { data: flipVertical(data, width, height), width, height };
    case 5:
      // Transpose (flip about the top-left diagonal): (x, y) -> (y, x).
      return { data: transpose(data, width, height), width: height, height: width };
    case 6:
      // 90 degrees clockwise: (x, y) -> (height - 1 - y, x).
      {
        const out = new Uint8ClampedArray(data.length);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const from = (y * width + x) * 4;
            const to = (x * height + (height - 1 - y)) * 4;
            out[to] = data[from];
            out[to + 1] = data[from + 1];
            out[to + 2] = data[from + 2];
            out[to + 3] = data[from + 3];
          }
        }
        return { data: out, width: height, height: width };
      }
    case 7:
      // Transverse (flip about the top-right diagonal): (x, y) -> (height - 1 - y, width - 1 - x).
      {
        const out = new Uint8ClampedArray(data.length);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const from = (y * width + x) * 4;
            const to = ((width - 1 - x) * height + (height - 1 - y)) * 4;
            out[to] = data[from];
            out[to + 1] = data[from + 1];
            out[to + 2] = data[from + 2];
            out[to + 3] = data[from + 3];
          }
        }
        return { data: out, width: height, height: width };
      }
    case 8:
      // 90 degrees counter-clockwise: (x, y) -> (y, width - 1 - x).
      {
        const out = new Uint8ClampedArray(data.length);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const from = (y * width + x) * 4;
            const to = ((width - 1 - x) * height + y) * 4;
            out[to] = data[from];
            out[to + 1] = data[from + 1];
            out[to + 2] = data[from + 2];
            out[to + 3] = data[from + 3];
          }
        }
        return { data: out, width: height, height: width };
      }
    default:
      return { data, width, height };
  }
}
