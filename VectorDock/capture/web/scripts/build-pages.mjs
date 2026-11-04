#!/usr/bin/env node
/** Build a minimal, allowlisted Cloudflare Pages directory without secrets. */
import { constants } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "_worker.js",
  "index.html",
  "css/app.css",
  "data/forecast-districts.json",
  "js/app.js",
  "js/lib/api.js",
  "js/lib/exif.js",
  "js/lib/idempotency.js",
  "js/lib/image-header.js",
  "js/lib/qr-decoder.js",
  "js/lib/qr-scan.js",
  "js/lib/qr.js",
  "js/lib/session.js",
  "js/lib/status.js",
  "vendor/jsQR.js",
  "vendor/jsQR.LICENSE",
];

async function assertRegularSource(relative) {
  let cursor = root;
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link source: ${relative}`);
  }
  if (!(await lstat(cursor)).isFile()) throw new Error(`Expected a regular file: ${relative}`);
}

async function main() {
  if (process.argv.length > 3) throw new Error("Usage: node scripts/build-pages.mjs [new-output-directory]");
  const destination = path.resolve(process.argv[2] || path.join(root, "dist"));
  if (destination === root || root.startsWith(destination + path.sep)) {
    throw new Error("The output directory cannot be the source directory or its ancestor");
  }
  // Validate every source before creating output. A pre-existing output folder
  // is never deleted or reused, even when it looks like a previous build.
  for (const file of files) await assertRegularSource(file);
  await mkdir(destination);
  for (const file of files) {
    const target = path.join(destination, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, ...file.split("/")), target, constants.COPYFILE_EXCL);
  }
  console.log(`Prepared ${files.length} allowlisted Pages files in ${destination}`);
  console.log("No tests, fixtures, node_modules, local configuration, or secrets were included.");
}

main().catch((error) => {
  console.error(`Pages build refused: ${error.message}`);
  process.exitCode = 1;
});
