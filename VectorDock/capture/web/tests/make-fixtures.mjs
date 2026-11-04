/**
 * Generates the photo QR decoding fixtures (real QR images, not mock strings).
 *
 * Run from VectorDock/capture/web:
 *   node tests/make-fixtures.mjs
 *
 * Requires the pinned devDependencies (qrcode). The EXIF-rotated JPEG fixture
 * is produced afterwards by tests/make-exif-fixture.py with the backend
 * virtualenv's Pillow.
 *
 * Fixtures are committed; regenerate only when a payload format changes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";

const OUT = path.resolve(import.meta.dirname, "fixtures");
await mkdir(OUT, { recursive: true });

const TRAP = "VD-TEST-001";
const OWN_ORIGIN = "https://capture.example.com";

const payload = {
  token: `VD1:TRAP:${TRAP}`,
  legacy: [
    "VECTORDOCK CONTAINER",
    `ID: ${TRAP}`,
    "Site: TEST-SITE",
    "Location: test fixture location",
    "Deployed: 2026-01-05",
  ].join("\n"),
  captureUrl: `${OWN_ORIGIN}/capture?trap=${TRAP}`,
  wrongTrap: "VD1:TRAP:VD-OTHER-9",
  maps: "https://maps.google.com/?q=TEST-SITE",
};

async function qrPng(text, { width = 260, margin = 2 } = {}) {
  return QRCode.toBuffer(text, { type: "png", width, margin, errorCorrectionLevel: "M" });
}

import { PNG } from "pngjs";

async function decode(pngBuffer) {
  return PNG.sync.read(pngBuffer);
}

function paste(base, overlay, x, y) {
  for (let row = 0; row < overlay.height; row += 1) {
    for (let col = 0; col < overlay.width; col += 1) {
      const tx = x + col;
      const ty = y + row;
      if (tx < 0 || ty < 0 || tx >= base.width || ty >= base.height) {
        continue;
      }
      const from = (row * overlay.width + col) * 4;
      const to = (ty * base.width + tx) * 4;
      const alpha = overlay.data[from + 3] / 255;
      if (alpha === 0) {
        continue;
      }
      base.data[to] = Math.round(overlay.data[from] * alpha + base.data[to] * (1 - alpha));
      base.data[to + 1] = Math.round(overlay.data[from + 1] * alpha + base.data[to + 1] * (1 - alpha));
      base.data[to + 2] = Math.round(overlay.data[from + 2] * alpha + base.data[to + 2] * (1 - alpha));
      base.data[to + 3] = 255;
    }
  }
}

function newPhoto(width, height, baseColor) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = baseColor[0];
    png.data[i * 4 + 1] = baseColor[1];
    png.data[i * 4 + 2] = baseColor[2];
    png.data[i * 4 + 3] = 255;
  }
  return png;
}

/** Rough "collection surface" background so fixtures look like photos, not bare codes. */
function decorate(png) {
  const dark = [90, 140, 60];
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if ((x > 24 && x < png.width - 24 && y > 24 && y < png.height - 24) === false) {
        continue;
      }
      const onSurface = x > 30 && x < png.width - 30 && y > 30 && y < png.height - 30;
      if (!onSurface) {
        continue;
      }
      const index = (y * png.width + x) * 4;
      png.data[index] = dark[0];
      png.data[index + 1] = dark[1];
      png.data[index + 2] = dark[2];
    }
  }
  return png;
}

async function write(name, png) {
  const file = path.join(OUT, name);
  await writeFile(file, PNG.sync.write(png));
  console.log(`wrote ${name}`);
}

async function single(name, text) {
  const base = decorate(newPhoto(420, 320, [246, 244, 236]));
  const qr = await decode(await qrPng(text));
  paste(base, qr, (base.width - qr.width) >> 1, (base.height - qr.height) >> 1);
  await write(name, base);
}

await single("photo-qr-token.png", payload.token);
await single("photo-qr-legacy.png", payload.legacy);
await single("photo-qr-capture-url.png", payload.captureUrl);
await single("photo-qr-wrong-trap.png", payload.wrongTrap);
await single("photo-qr-maps.png", payload.maps);

// Two conflicting container QRs in one photo.
{
  const base = decorate(newPhoto(760, 420, [246, 244, 236]));
  const left = await decode(await qrPng(payload.token, { width: 200 }));
  const right = await decode(await qrPng(payload.wrongTrap, { width: 200 }));
  paste(base, left, 50, (base.height - left.height) >> 1);
  paste(base, right, base.width - right.width - 50, (base.height - right.height) >> 1);
  await write("photo-qr-conflict.png", base);
}

// Duplicate (identical) QRs: same ID twice is not a conflict.
{
  const base = decorate(newPhoto(760, 420, [246, 244, 236]));
  const left = await decode(await qrPng(payload.token, { width: 200 }));
  paste(base, left, 50, (base.height - left.height) >> 1);
  paste(base, left, base.width - left.width - 50, (base.height - left.height) >> 1);
  await write("photo-qr-duplicate.png", base);
}

// No QR at all.
{
  const base = decorate(newPhoto(420, 320, [246, 244, 236]));
  await write("photo-no-qr.png", base);
}

console.log("payload summary:", JSON.stringify(payload, null, 2));
