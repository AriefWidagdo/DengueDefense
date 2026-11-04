/**
 * Unit checks for the Cloudflare Pages advanced-mode worker (`_worker.js`).
 * Run with: node tests/worker.test.mjs
 * No network access: the backend is a stubbed global fetch.
 */

import assert from "node:assert/strict";
import worker, { isProxiedApiRoute, resolveBackendConfig, readBodyCapped, bodyLimit } from "../_worker.js";

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

/* ---------------------------------------------------- route allowlist */

await test("allowlist accepts the intended capture routes", () => {
  const allowed = [
    ["POST", "/api/auth/login"],
    ["POST", "/api/auth/logout"],
    ["GET", "/api/auth/me"],
    ["GET", "/api/health"],
    ["POST", "/api/forecasts"],
    ["GET", "/api/traps/VD-001"],
    ["POST", "/api/traps/VD-001/samples"],
    ["PATCH", "/api/samples/12"],
    ["POST", "/api/samples/12/images"],
    ["POST", "/api/samples/12/reviews"],
    ["GET", "/api/uploads/abc123"],
    ["POST", "/api/uploads/abc123/poll"],
    ["GET", "/api/images/abc123/original"],
    ["GET", "/api/results/abc123/annotation"],
  ];
  for (const [method, path] of allowed) {
    assert.equal(isProxiedApiRoute(method, path), true, `${method} ${path}`);
  }
});

await test("allowlist refuses everything else", () => {
  const refused = [
    ["GET", "/api/auth/login"], // wrong method
    ["POST", "/api/health"],
    ["GET", "/api/forecasts"],
    ["POST", "/api/forecasts/other"],
    ["POST", "/api/admin/recovery"], // admin console route, not proxied
    ["GET", "/api/admin/recovery"],
    ["GET", "/api/"],
    ["GET", "/api/unknown"],
    ["GET", "/api/traps/VD-001/anything"],
    ["DELETE", "/api/samples/12"],
    ["GET", "/api/samples/12/images"],
    ["GET", "/api/traps/"], // empty segment
    ["PATCH", "/api/samples/abc"], // sample ids are numeric
    ["GET", "/api/results/abc"], // wrong shape
    ["GET", "/api/uploads/abc123/poll"], // poll is a checked write
    ["POST", "/api/uploads/abc123/poll/extra"],
    ["GET", "/api/proxy?target=https://evil.example"], // no arbitrary proxying
  ];
  for (const [method, path] of refused) {
    assert.equal(isProxiedApiRoute(method, path), false, `${method} ${path}`);
  }
});

/* ---------------------------------------------------- config resolution */

await test("missing backend origin is a configuration problem", () => {
  const config = resolveBackendConfig({});
  assert.equal(config.problems.length > 0, true);
  assert.equal(config.origin, "");
});

await test("https backend origin is accepted", () => {
  const config = resolveBackendConfig({ CAPTURE_BACKEND_ORIGIN: "https://capture-backend.example.com" });
  assert.deepEqual(config.problems, []);
  assert.equal(config.origin, "https://capture-backend.example.com");
});

await test("plain http is allowed only for localhost development", () => {
  assert.deepEqual(resolveBackendConfig({ CAPTURE_BACKEND_ORIGIN: "http://127.0.0.1:8000" }).problems, []);
  assert.deepEqual(resolveBackendConfig({ CAPTURE_BACKEND_ORIGIN: "http://localhost:8000" }).problems, []);
  const remote = resolveBackendConfig({ CAPTURE_BACKEND_ORIGIN: "http://backend.example.com" });
  assert.equal(remote.problems.length, 1);
});

await test("production refuses http, localhost and a short or missing relay token", () => {
  const http = resolveBackendConfig({
    CAPTURE_ENVIRONMENT: "production",
    CAPTURE_BACKEND_ORIGIN: "http://backend.example.com",
    CAPTURE_RELAY_TOKEN: "x".repeat(32),
  });
  assert.equal(http.problems.some((p) => p.includes("https")), true);

  const localhost = resolveBackendConfig({
    CAPTURE_ENVIRONMENT: "production",
    CAPTURE_BACKEND_ORIGIN: "http://127.0.0.1:8000",
    CAPTURE_RELAY_TOKEN: "x".repeat(32),
  });
  assert.equal(localhost.problems.length > 0, true);

  const shortToken = resolveBackendConfig({
    CAPTURE_ENVIRONMENT: "production",
    CAPTURE_BACKEND_ORIGIN: "https://backend.example.com",
    CAPTURE_RELAY_TOKEN: "short",
  });
  assert.equal(shortToken.problems.some((p) => p.includes("CAPTURE_RELAY_TOKEN")), true);

  const noToken = resolveBackendConfig({
    CAPTURE_ENVIRONMENT: "production",
    CAPTURE_BACKEND_ORIGIN: "https://backend.example.com",
  });
  assert.equal(noToken.problems.some((p) => p.includes("CAPTURE_RELAY_TOKEN")), true);
});

await test("origin with a path, query or fragment is refused", () => {
  for (const bad of ["https://backend.example.com/api/", "https://backend.example.com?x=1", "ftp://backend.example.com"]) {
    assert.equal(resolveBackendConfig({ CAPTURE_BACKEND_ORIGIN: bad }).problems.length > 0, true, bad);
  }
});

/* ---------------------------------------------------- fetch behavior */

const ORIGINAL_FETCH = globalThis.fetch;

async function captureBackendCall(request, env, backendResponse) {
  let seen = null;
  globalThis.fetch = async (target, init) => {
    seen = { target, init, request: new Request(target, init) };
    return backendResponse ?? new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await worker.fetch(request, env);
    return { response, seen };
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
}

const DEV_ENV = {
  CAPTURE_BACKEND_ORIGIN: "https://backend.example.com",
  CAPTURE_RELAY_TOKEN: "relay-token-for-tests-only-0123456789",
};

await test("unknown /api path returns 404 without contacting any backend", async () => {
  const { response, seen } = await captureBackendCall(
    new Request("https://capture.example.com/api/nope", { method: "GET" }),
    DEV_ENV,
  );
  assert.equal(response.status, 404);
  assert.equal(seen, null);
  const body = await response.json();
  assert.equal(body.error, "not_found");
});

await test("missing configuration returns a truthful 503 and never leaks the token", async () => {
  const { response, seen } = await captureBackendCall(
    new Request("https://capture.example.com/api/health", { method: "GET" }),
    {},
  );
  assert.equal(response.status, 503);
  assert.equal(seen, null);
  const text = await response.text();
  assert.match(text, /not configured/);
  assert.doesNotMatch(text, /Bearer/);
});

await test("proxied request targets the configured origin with the relay credential", async () => {
  const request = new Request("https://capture.example.com/api/traps/VD-001", {
    method: "GET",
    headers: { cookie: "vd_session=tok", authorization: "Bearer client-supplied-must-go" },
  });
  const { response, seen } = await captureBackendCall(request, DEV_ENV);
  assert.equal(response.status, 200);
  assert.equal(seen.target.origin, "https://backend.example.com");
  assert.equal(seen.target.pathname, "/api/traps/VD-001");
  const auth = seen.request.headers.get("authorization");
  assert.equal(auth, `Bearer ${DEV_ENV.CAPTURE_RELAY_TOKEN}`);
  assert.notEqual(auth, "Bearer client-supplied-must-go");
  assert.equal(seen.request.headers.get("cookie"), "vd_session=tok");
});

await test("spoofable identity headers are stripped before forwarding", async () => {
  const headers = new Headers({ cookie: "vd_session=tok" });
  for (const name of ["x-vd-operator", "x-forwarded-user", "x-remote-user", "x-user-id", "x-vd-user", "x-authenticated-user", "x-operator-id"]) {
    headers.set(name, "attacker");
  }
  const request = new Request("https://capture.example.com/api/auth/me", { method: "GET", headers });
  const { seen } = await captureBackendCall(request, DEV_ENV);
  for (const name of ["x-vd-operator", "x-forwarded-user", "x-remote-user", "x-user-id", "x-vd-user", "x-authenticated-user", "x-operator-id"]) {
    assert.equal(seen.request.headers.get(name), null, name);
  }
  assert.equal(seen.request.headers.get("cookie"), "vd_session=tok");
});

await test("csrf header and write method with body are forwarded", async () => {
  const form = new FormData();
  form.set("client_key", "vd1-test-key-0001");
  form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "photo.png");
  const request = new Request("https://capture.example.com/api/samples/1/images", {
    method: "POST",
    headers: {
      cookie: "vd_session=tok",
      "x-csrf-token": "csrf-value",
      origin: "https://capture.example.com",
    },
    body: form,
  });
  const { seen } = await captureBackendCall(request, DEV_ENV, new Response(JSON.stringify({ upload_id: "u1" }), { status: 202 }));
  assert.equal(seen.request.method, "POST");
  assert.equal(seen.request.headers.get("x-csrf-token"), "csrf-value");
  assert.equal(seen.request.headers.get("origin"), "https://capture.example.com");
  const forwarded = await seen.request.formData();
  assert.equal(forwarded.get("client_key"), "vd1-test-key-0001");
  assert.equal((await forwarded.get("file").arrayBuffer()).byteLength, 3);
});

await test("set-cookie from the backend reaches the browser; hop-by-hop headers are stripped", async () => {
  const request = new Request("https://capture.example.com/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://capture.example.com" },
    body: JSON.stringify({ username: "test-worker", password: "pw" }),
  });
  const backend = new Response("{}", {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "vd_session=abc; HttpOnly; SameSite=Lax",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
    },
  });
  const { response } = await captureBackendCall(request, DEV_ENV, backend);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /vd_session=abc/);
  assert.equal(response.headers.get("connection"), null);
  assert.equal(response.headers.get("transfer-encoding"), null);
});

await test("backend failure returns a truthful 502, not a success shape", async () => {
  globalThis.fetch = async () => {
    throw new Error("connection refused");
  };
  try {
    const response = await worker.fetch(
      new Request("https://capture.example.com/api/health", { method: "GET" }),
      DEV_ENV,
    );
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, "backend_unreachable");
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});

await test("non-API paths are served from the static asset binding", async () => {
  const assetResponse = new Response("<html>capture page</html>", { status: 200, headers: { "content-type": "text/html" } });
  let assetRequestSeen = null;
  const env = {
    ...DEV_ENV,
    ASSETS: { fetch: async (request) => { assetRequestSeen = request; return assetResponse; } },
  };
  const response = await worker.fetch(new Request("https://capture.example.com/index.html"), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<html>capture page</html>");
  assert.equal(assetRequestSeen.url, "https://capture.example.com/index.html");
});

await test("missing asset binding is reported instead of crashing", async () => {
  const response = await worker.fetch(new Request("https://capture.example.com/index.html"), { ...DEV_ENV });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "assets_binding_missing");
});

await test("body limit: oversized declared Content-Length is refused before reading", async () => {
  const request = {
    headers: new Headers({ "content-length": "999999999" }),
    body: null,
  };
  const read = await readBodyCapped(request, 1000);
  assert.equal(read.tooLarge, true);
});

await test("body limit: a lying Content-Length cannot smuggle an oversized body", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(400).fill(1);
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = {
    headers: new Headers({ "content-length": "10" }),
    body: stream,
  };
  const read = await readBodyCapped(request, 1000);
  assert.equal(read.tooLarge, true);
  assert.equal(cancelled, true);
});

await test("body limit: chunked body without Content-Length is streamed under the cap", async () => {
  const a = new Uint8Array(40).fill(7);
  const b = new Uint8Array(60).fill(9);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(a);
      controller.enqueue(b);
      controller.close();
    },
  });
  const request = { headers: new Headers(), body: stream };
  const read = await readBodyCapped(request, 1000);
  assert.equal(read.tooLarge, undefined);
  assert.equal(read.body.byteLength, 100);
  assert.equal(read.body[0], 7);
  assert.equal(read.body[40], 9);
});

await test("body limit: an oversized real request gets a truthful 413 with no backend contact", async () => {
  let seen = null;
  globalThis.fetch = async (target, init) => {
    seen = { target, init };
    return new Response("{}", { status: 200 });
  };
  try {
    const big = new Uint8Array(128 * 1024).fill(5);
    const request = new Request("https://capture.example.com/api/samples/1/images", {
      method: "POST",
      headers: { cookie: "vd_session=tok" },
      body: big,
    });
    const response = await worker.fetch(request, { ...DEV_ENV, CAPTURE_MAX_BODY_BYTES: "65536" });
    assert.equal(response.status, 413);
    assert.equal(seen, null);
    const body = await response.json();
    assert.equal(body.error, "request_too_large");
    assert.match(body.detail, /Nothing was uploaded/);
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});

await test("body limit: default cap covers 12 MiB plus multipart overhead; tiny values fall back", () => {
  assert.equal(bodyLimit({}), 14 * 1024 * 1024);
  assert.equal(bodyLimit({ CAPTURE_MAX_BODY_BYTES: "131072" }), 131072);
  // A value below the 64 KiB floor falls back to the safe default.
  assert.equal(bodyLimit({ CAPTURE_MAX_BODY_BYTES: "10" }), 14 * 1024 * 1024);
});

console.log(`\nworker.test: ${passed} checks passed`);
