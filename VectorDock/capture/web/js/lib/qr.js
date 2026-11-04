/**
 * QR payload parsing and multi-QR photo resolution.
 *
 * Contract (VectorDock/qr-labels/QR_PAYLOAD.md):
 * - `VD1:TRAP:<trap_id>` - the preferred versioned identifier token.
 * - Legacy details labels start with the exact line `VECTORDOCK CONTAINER`
 *   and carry exactly one `ID: <trap_id>` line. Location/date text inside
 *   the QR is never registry truth.
 * - `{configured_origin}/capture?trap=<trap_id>` is accepted only when the
 *   origin matches the configured application origin. QR content never
 *   navigates the page and never grants permission.
 * - Maps QRs carry no container ID and cannot identify a container.
 * - A trap ID is `2-40` chars of uppercase A-Z, digits and hyphens, starting
 *   with a letter or digit.
 */

const TRAP_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,39}$/;
const TOKEN_PREFIX = "VD1:TRAP:";
const LEGACY_HEADER = "VECTORDOCK CONTAINER";

export function isValidTrapId(value) {
  return typeof value === "string" && TRAP_ID_PATTERN.test(value);
}

function sanitizeTrapId(value) {
  return (value || "").trim().toUpperCase();
}

/**
 * Parse one decoded QR string.
 * Returns { status: "trap", trapId } or { status: "unknown", reason }.
 */
export function parseQrPayload(raw, { ownOrigin = null } = {}) {
  const text = (raw || "").trim();
  if (!text) {
    return { status: "unknown", reason: "The QR payload is empty." };
  }

  // Preferred versioned token: VD1:TRAP:<trap_id>
  if (text.startsWith(TOKEN_PREFIX)) {
    const trapId = sanitizeTrapId(text.slice(TOKEN_PREFIX.length));
    if (!isValidTrapId(trapId)) {
      return { status: "unknown", reason: "The VD1:TRAP payload carries an invalid container ID." };
    }
    return { status: "trap", trapId };
  }

  // Legacy details label: exact header line, exactly one usable ID line.
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] === LEGACY_HEADER) {
    const idLines = lines.filter((line) => /^ID:/i.test(line));
    if (idLines.length !== 1) {
      return { status: "unknown", reason: idLines.length === 0
        ? "The container label has no ID line."
        : "The container label has conflicting ID lines." };
    }
    const value = sanitizeTrapId(idLines[0].slice(3));
    if (!isValidTrapId(value)) {
      return { status: "unknown", reason: "The container label carries an invalid container ID." };
    }
    // Location/date lines are ignored as authority; only the ID is used.
    return { status: "trap", trapId: value };
  }

  // Configured-origin capture URL: {origin}/capture?trap=<trap_id>
  if (/^https?:\/\//i.test(text)) {
    let url = null;
    try {
      url = new URL(text);
    } catch {
      return { status: "unknown", reason: "The QR carries a malformed URL. It was not opened." };
    }
    // Maps and similar location-only links carry no container ID.
    if (/(^|\.)maps?\./i.test(url.hostname) || /\/maps(\/|$)/i.test(url.pathname) || url.hostname.endsWith("goo.gl")) {
      return { status: "unknown", reason: "This QR carries no container ID (for example a map link)." };
    }
    const expectedOrigin = ownOrigin ? ownOrigin.replace(/\/+$/, "") : null;
    if (!expectedOrigin || url.origin !== expectedOrigin) {
      return { status: "unknown", reason: "The QR points at an unknown site. QR content never opens automatically." };
    }
    if (url.pathname.replace(/\/+$/, "") !== "/capture") {
      return { status: "unknown", reason: "The QR URL is not the capture page of this application." };
    }
    const trapValues = url.searchParams.getAll("trap");
    if (trapValues.length === 0) {
      return { status: "unknown", reason: "The capture URL has no container ID." };
    }
    // Any repeated trap parameter is refused, even when the values are
    // identical: a duplicate is a malformed or tampered label.
    if (trapValues.length > 1) {
      return { status: "unknown", reason: "The capture URL has duplicated or conflicting container IDs." };
    }
    const trapId = sanitizeTrapId(trapValues[0]);
    if (!isValidTrapId(trapId)) {
      return { status: "unknown", reason: "The capture URL carries an invalid container ID." };
    }
    return { status: "trap", trapId };
  }

  // Maps URLs, free text and anything else identify no container.
  return { status: "unknown", reason: "This QR carries no container ID (for example a map link)." };
}

/**
 * Resolve all decoded payloads from one photo.
 * Returns one of:
 *   { status: "no_qr" }
 *   { status: "unknown", reasons: [...] }
 *   { status: "trap", trapId }
 *   { status: "conflict", ids: [...] }   // multiple distinct container IDs
 */
export function resolvePhotoQr(payloads, { ownOrigin = null } = {}) {
  const parsed = (payloads || []).map((payload) => parseQrPayload(payload, { ownOrigin }));
  if (parsed.length === 0) {
    return { status: "no_qr" };
  }
  const trapIds = [...new Set(parsed.filter((item) => item.status === "trap").map((item) => item.trapId))];
  if (trapIds.length > 1) {
    return { status: "conflict", ids: trapIds.sort() };
  }
  if (trapIds.length === 1) {
    return { status: "trap", trapId: trapIds[0] };
  }
  const reasons = [...new Set(parsed.map((item) => item.reason))];
  return { status: "unknown", reasons };
}
