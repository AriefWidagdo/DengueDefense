/**
 * Local integration check: the real `_worker.js` proxy against the real
 * VectorDock capture backend running on localhost.
 *
 * Everything is local and offline: a local uvicorn process, a local SQLite
 * database, local disk storage and the backend's own fake adapter (no Modal
 * configuration, so counting jobs honestly end in a failed state).
 *
 * Run with: node tests/integration.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import net from "node:net";
import worker from "../_worker.js";
import { captureTimeParts } from "../js/lib/idempotency.js";

const BACKEND_DIR = path.resolve(import.meta.dirname, "../../backend");
const PYTHON = process.env.VECTORDOCK_TEST_PYTHON || path.join(
  BACKEND_DIR, ".venv", process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
const PAGES_ORIGIN = "http://127.0.0.1:8788";
// Allocate a free loopback port. Never connect tests to an unrelated service
// that happens to be listening on the old fixed test port.
const BACKEND_PORT = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close((error) => error ? reject(error) : resolve(port));
  });
});
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`;
const RELAY_TOKEN = "integration-relay-token-0123456789abcdef";
const WORKER_PASSWORD = "field-worker-test-pass";
const REVIEWER_PASSWORD = "field-reviewer-test-pass";

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL - ${name}`);
      throw error;
    });
}

/* ------------------------------------------------------------ tiny PNG */

function pngBytes(width = 8, height = 6) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of typeAndData) {
      crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc);
    return Buffer.concat([length, typeAndData, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    raw[row * (1 + width * 3)] = 0; // filter type: none
    for (let col = 0; col < width; col += 1) {
      const offset = row * (1 + width * 3) + 1 + col * 3;
      raw[offset] = 200;
      raw[offset + 1] = 180;
      raw[offset + 2] = 120;
    }
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ worker harness */

const ENV = {
  CAPTURE_BACKEND_ORIGIN: BACKEND_ORIGIN,
  CAPTURE_RELAY_TOKEN: RELAY_TOKEN,
  CAPTURE_ENVIRONMENT: "development",
  ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
};

const jar = { cookie: "" };

function browserRequest(path, { method = "GET", headers = {}, body } = {}) {
  const allHeaders = { ...headers };
  if (jar.cookie) {
    allHeaders.cookie = jar.cookie;
  }
  allHeaders.origin = PAGES_ORIGIN;
  return new Request(PAGES_ORIGIN + path, { method, headers: allHeaders, body });
}

function collectCookies(response) {
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const cookie of cookies) {
    const pair = cookie.split(";", 1)[0];
    if (pair.startsWith("vd_session=")) {
      jar.cookie = pair;
    }
  }
}

/* ------------------------------------------------------------ backend process */

let backend = null;
let workDir = null;

async function startBackend() {
  workDir = await mkdtemp(path.join(tmpdir(), "vd-capture-web-"));
  const baseEnv = {
    ...process.env,
    CAPTURE_ENV: "development",
    DATABASE_URL: `sqlite:///${(path.join(workDir, "capture.sqlite3")).replace(/\\/g, "/")}`,
    CAPTURE_STORAGE_DIR: path.join(workDir, "storage"),
    CAPTURE_ALLOWED_ORIGINS: PAGES_ORIGIN,
    CAPTURE_RELAY_TOKEN: RELAY_TOKEN,
    CAPTURE_PUBLIC_BASE_URL: PAGES_ORIGIN,
    CAPTURE_MODAL_ENABLED: "0",
  };
  const seed = spawn(PYTHON, [
    "-m", "app.cli", "seed-fixtures",
    "--worker-password", WORKER_PASSWORD,
    "--reviewer-password", REVIEWER_PASSWORD,
  ], { cwd: BACKEND_DIR, env: baseEnv });
  await waitExit(seed);
  backend = spawn(PYTHON, [
    "-m", "uvicorn", "app.main:create_app", "--factory", "--port", String(BACKEND_PORT),
  ], { cwd: BACKEND_DIR, env: baseEnv });
  backend.stderr.on("data", (chunk) => process.env.VD_DEBUG && process.stderr.write(chunk));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const probe = await fetch(`${BACKEND_ORIGIN}/api/health`);
      if (probe.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error("backend did not become healthy on localhost");
}

function waitExit(child) {
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`process exited with ${code}`))));
    child.on("error", reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopBackend() {
  if (backend) {
    backend.kill();
    await sleep(300);
  }
  if (workDir) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  await startBackend();

  let csrfToken = null;

  await test("health through the proxy", async () => {
    const response = await worker.fetch(browserRequest("/api/health"), ENV);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.database, "sqlite");
  });

  await test("login sets the session cookie and returns the CSRF token", async () => {
    const response = await worker.fetch(browserRequest("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "test-worker", password: WORKER_PASSWORD }),
    }), ENV);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    collectCookies(response);
    assert.match(jar.cookie, /^vd_session=/);
    const body = JSON.parse(text);
    csrfToken = body.csrf_token;
    assert.equal(body.operator.username, "test-worker");
    assert.equal(body.operator.role, "worker");
  });

  await test("me resolves the session through the proxy", async () => {
    const response = await worker.fetch(browserRequest("/api/auth/me"), ENV);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.operator.username, "test-worker");
    assert.ok(body.granted_trap_ids.includes("VD-TEST-001"));
  });

  await test("spoofed identity header is stripped by the proxy, not rejected as forged", async () => {
    const response = await worker.fetch(browserRequest("/api/auth/me", {
      headers: { "x-vd-operator": "test-reviewer", "x-forwarded-user": "test-reviewer" },
    }), ENV);
    // The proxy strips the header; the backend resolves the session normally
    // instead of answering 400 (forged identity) or trusting the header.
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(JSON.parse(text).operator.username, "test-worker");
  });

  await test("QR trap identifier resolves the registered trap and site", async () => {
    const response = await worker.fetch(browserRequest("/api/traps/VD-TEST-001"), ENV);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.trap_id, "VD-TEST-001");
    assert.equal(body.is_test_fixture, true);
    assert.equal(body.site_id, "TEST-SITE");
    assert.ok(body.active_deployment);
  });

  await test("unknown or unauthorized trap never resolves silently", async () => {
    // The backend gives an unknown trap the same refusal as an unauthorized
    // one (no existence oracle): 403 without trap details.
    const response = await worker.fetch(browserRequest("/api/traps/VD-NOPE-404"), ENV);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.detail, /grant/i);
  });

  let sampleId = null;
  await test("create an adult-card sample with installation time", async () => {
    const response = await worker.fetch(browserRequest(`/api/traps/VD-TEST-001/samples`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({
        sample_type: "adult_card",
        installed_at: "2026-01-05T08:00:00",
        installed_at_offset: "+08:00",
        cartridge_id: "INT-TEST-CARD-1",
      }),
    }), ENV);
    const text = await response.text();
    assert.equal(response.status, 201, text);
    const body = JSON.parse(text);
    sampleId = body.sample_id;
    assert.equal(body.sample_type, "adult_card");
    assert.equal(body.revision, 1);
  });

  await test("record removal with the expected revision; stale revision fails", async () => {
    const ok = await worker.fetch(browserRequest(`/api/samples/${sampleId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({
        expected_revision: 1,
        removed_at: "2026-01-12T08:00:00",
        removed_at_offset: "+08:00",
        condition_notes: "intact, dry",
      }),
    }), ENV);
    const okText = await ok.text();
    assert.equal(ok.status, 200, okText);
    assert.equal(JSON.parse(okText).sample.revision, 2);

    const stale = await worker.fetch(browserRequest(`/api/samples/${sampleId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ expected_revision: 1 }),
    }), ENV);
    assert.equal(stale.status, 409);
  });

  const bytes = pngBytes();
  const clientKey = "vd1-integration-key-0001";
  let uploadId = null;

  // Capture time near now: the backend refuses times more than 90 days old.
  const captured = captureTimeParts(new Date(Date.now() - 2 * 60 * 60 * 1000));
  function uploadForm(data, key) {
    const form = new FormData();
    form.set("client_key", key);
    form.set("captured_at", captured.capturedAt);
    form.set("captured_at_offset", captured.capturedAtOffset);
    form.set("file", new Blob([data], { type: "image/png" }), "surface.png");
    return form;
  }

  await test("multipart upload is accepted with 202 after durable save", async () => {
    const response = await worker.fetch(browserRequest(`/api/samples/${sampleId}/images`, {
      method: "POST",
      headers: { "x-csrf-token": csrfToken },
      body: uploadForm(bytes, clientKey),
    }), ENV);
    const text = await response.text();
    assert.equal(response.status, 202, text);
    const body = JSON.parse(text);
    uploadId = body.upload_id;
    assert.equal(body.status, "stored");
    assert.ok(body.image_id);
  });

  await test("same key with the same content returns the existing upload (200)", async () => {
    const response = await worker.fetch(browserRequest(`/api/samples/${sampleId}/images`, {
      method: "POST",
      headers: { "x-csrf-token": csrfToken },
      body: uploadForm(bytes, clientKey),
    }), ENV);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.upload_id, uploadId);
  });

  await test("same key with different content fails with 409", async () => {
    const response = await worker.fetch(browserRequest(`/api/samples/${sampleId}/images`, {
      method: "POST",
      headers: { "x-csrf-token": csrfToken },
      body: uploadForm(Buffer.concat([bytes, Buffer.from([1])]), clientKey),
    }), ENV);
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.detail, /retake/);
  });

  await test("upload status is truthful: stored job fails without a configured counter, no fabricated count", async () => {
    const response = await worker.fetch(browserRequest(`/api/uploads/${uploadId}`), ENV);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "stored");
    assert.equal(body.processing.state, "failed");
    assert.match(body.processing.failure_reason, /not configured|Adapter/i);
    assert.equal(body.review.state, "pending_review");
    assert.equal(body.result, null);
  });

  await test("a worker cannot submit a review (reviewer role required)", async () => {
    const response = await worker.fetch(browserRequest(`/api/samples/${sampleId}/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({
        expected_sample_revision: 2,
        image_id: "whatever",
        decision: "accepted",
      }),
    }), ENV);
    assert.equal(response.status, 403);
  });

  await test("logout clears the session; later calls are unauthorized", async () => {
    const response = await worker.fetch(browserRequest("/api/auth/logout", {
      method: "POST",
      headers: { "x-csrf-token": csrfToken },
    }), ENV);
    assert.equal(response.status, 204);
    const after = await worker.fetch(browserRequest("/api/auth/me"), ENV);
    assert.equal(after.status, 401);
  });

  await test("reviewer can sign in through the proxy", async () => {
    const response = await worker.fetch(browserRequest("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "test-reviewer", password: REVIEWER_PASSWORD }),
    }), ENV);
    collectCookies(response);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.operator.role, "reviewer");
  });

  await test("relayed write without CSRF header still succeeds (relay transport is CSRF-exempt, Origin-checked)", async () => {
    // The relay credential marks the request as the Pages proxy transport;
    // the backend exempts it from the CSRF check but still enforces the
    // Origin allowlist (see the next check). The page still sends its CSRF
    // token; the exemption only covers the worker's forwarded transport.
    const response = await worker.fetch(browserRequest(`/api/traps/VD-TEST-001/samples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sample_type: "egg_strip", installed_at: "2026-01-05T08:00:00", strip_id: "INT-TEST-STRIP-1" }),
    }), ENV);
    const detailText = await response.text();
    assert.equal(response.status, 201, detailText);
  });

  await test("foreign Origin on a write is refused", async () => {
    const allHeaders = { ...jar.cookie ? { cookie: jar.cookie } : {}, origin: "https://evil.example", "content-type": "application/json" };
    const response = await worker.fetch(
      new Request(`${PAGES_ORIGIN}/api/traps/VD-TEST-001/samples`, {
        method: "POST",
        headers: allHeaders,
        body: JSON.stringify({ sample_type: "egg_strip", installed_at: "2026-01-05T08:00:00" }),
      }),
      ENV,
    );
    assert.equal(response.status, 403);
  });

  console.log(`\nintegration.test: ${passed} checks passed`);
} finally {
  await stopBackend();
}
