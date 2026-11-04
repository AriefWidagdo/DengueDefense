/**
 * Idempotency key and capture-time helpers.
 *
 * The backend keys an upload by the client-supplied `client_key`:
 * - the same key with the same content returns the existing upload (200),
 * - the same key with different content fails with 409,
 * - a deliberate retake uses a new key and a new image under the same sample.
 * The key is generated once per capture and is reused for every in-page
 * retry of the same photo. It is never derived from image content.
 */

const KEY_PREFIX = "vd1-";

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a new stable client idempotency key (128 bits of randomness). */
export function newClientKey(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return KEY_PREFIX + bytesToBase64Url(bytes);
}

export function isValidClientKey(key) {
  return typeof key === "string" && key.startsWith(KEY_PREFIX) && key.length >= 8 && key.length <= 128;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/**
 * Local wall-clock time as a naive ISO string, plus the explicit UTC offset.
 * The backend stores both, keeping the worker's exposure times separate from
 * server receipt times (spec section 5).
 */
export function captureTimeParts(date = new Date()) {
  const naive = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const minutesOffset = -date.getTimezoneOffset();
  const sign = minutesOffset >= 0 ? "+" : "-";
  const abs = Math.abs(minutesOffset);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return { capturedAt: naive, capturedAtOffset: offset };
}

/** Split a `datetime-local` input value into the same parts. */
export function datetimeLocalParts(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value || "")) {
    return null;
  }
  const naive = value.length === 16 ? `${value}:00` : value;
  return {
    capturedAt: naive,
    capturedAtOffset: captureTimeParts().capturedAtOffset,
  };
}
