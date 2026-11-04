import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/build-pages.mjs");
const expected = [
  "_worker.js", "index.html", "css/app.css", "data/forecast-districts.json", "js/app.js", "js/lib/api.js",
  "js/lib/exif.js", "js/lib/idempotency.js", "js/lib/image-header.js",
  "js/lib/qr-decoder.js", "js/lib/qr-scan.js", "js/lib/qr.js",
  "js/lib/session.js", "js/lib/status.js", "vendor/jsQR.js", "vendor/jsQR.LICENSE",
].sort();

async function filesUnder(base, prefix = "") {
  const entries = await readdir(path.join(base, prefix), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(base, relative));
    else result.push(relative);
  }
  return result.sort();
}

test("Pages output contains only byte-identical allowed runtime files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "vd-pages-build-"));
  try {
    const output = path.join(temp, "site");
    execFileSync(process.execPath, [script, output], { cwd: root, stdio: "pipe" });
    assert.deepEqual(await filesUnder(output), expected);
    for (const file of expected) {
      assert.deepEqual(await readFile(path.join(output, file)), await readFile(path.join(root, file)), file);
    }
    assert.ok(!expected.some((file) => /(^|\/)(tests|node_modules|\.dev\.vars|\.env)(\/|$)/.test(file)));
    // A second build refuses the existing folder and never removes its data.
    await writeFile(path.join(output, "keep-user-file.txt"), "preserve");
    const retry = spawnSync(process.execPath, [script, output], { cwd: root, encoding: "utf8" });
    assert.notEqual(retry.status, 0);
    assert.equal(await readFile(path.join(output, "keep-user-file.txt"), "utf8"), "preserve");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("forecast district list contains the trained codes and provinces", async () => {
  const districts = JSON.parse(await readFile(path.join(root, "data/forecast-districts.json"), "utf8"));
  assert.equal(districts.length, 514);
  assert.equal(new Set(districts.map((district) => district.code)).size, 514);
  assert.ok(districts.every((district) => /^\d{2}\.\d{2}$/.test(district.code) && district.name && district.province));
  assert.equal(districts.find((district) => district.code === "31.73").province, "DKI Jakarta");
});

test("Pages build refuses source directories as output", () => {
  for (const target of [root, path.dirname(root)]) {
    const result = spawnSync(process.execPath, [script, target], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot be the source directory or its ancestor/);
  }
});
