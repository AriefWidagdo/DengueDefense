/**
 * VectorDock phone capture - Cloudflare Pages advanced-mode worker.
 *
 * Deployment convention (https://developers.cloudflare.com/pages/functions/advanced-mode/):
 * this `_worker.js` sits in the Pages output directory and takes full control
 * of every request. `/api/*` is proxied to the configured VectorDock capture
 * backend; every other path is served from the project's static assets with
 * `env.ASSETS.fetch()`.
 *
 * Rules enforced here:
 * - Only the intended capture API routes are proxied. Every other `/api/*`
 *   path is refused with 404. This is not an arbitrary URL proxy: the target
 *   host comes exclusively from the `CAPTURE_BACKEND_ORIGIN` binding.
 * - The backend relay credential lives only in the server-side binding
 *   `CAPTURE_RELAY_TOKEN`. It is attached to the forwarded request and is
 *   never returned to the browser, never logged and never echoed in errors.
 * - Spoofable identity headers are stripped from the client request before
 *   forwarding. The backend rejects them outright; the proxy must not become
 *   the channel that introduces them.
 * - Session cookies and the `X-CSRF-Token` header pass through untouched so
 *   the backend's named-operator sign-in/session/CSRF flow keeps working
 *   same-origin from the Pages domain.
 * - Unsafe or missing production configuration is rejected with a truthful,
 *   readable 503. No default host, no default credential.
 */

const IDENTITY_HEADERS = [
  "x-vd-operator",
  "x-vd-user",
  "x-forwarded-user",
  "x-remote-user",
  "x-authenticated-user",
  "x-user-id",
  "x-operator-id",
];

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * Method + path allowlist for the capture API. Path segments with user data
 * are constrained to the shapes the backend actually serves:
 * trap ids are non-empty segments, sample ids are numeric, upload/image and
 * result ids are opaque token segments.
 */
const API_ROUTES = [
  { method: "POST", pattern: /^\/api\/auth\/login$/ },
  { method: "POST", pattern: /^\/api\/auth\/logout$/ },
  { method: "GET", pattern: /^\/api\/auth\/me$/ },
  { method: "GET", pattern: /^\/api\/health$/ },
  { method: "POST", pattern: /^\/api\/forecasts$/ },
  { method: "GET", pattern: /^\/api\/traps\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/traps\/[^/]+\/samples$/ },
  { method: "GET", pattern: /^\/api\/traps\/[^/]+\/uploads$/ },
  { method: "GET", pattern: /^\/api\/samples\/\d+$/ },
  { method: "PATCH", pattern: /^\/api\/samples\/\d+$/ },
  { method: "POST", pattern: /^\/api\/samples\/\d+\/images$/ },
  { method: "POST", pattern: /^\/api\/samples\/\d+\/reviews$/ },
  { method: "GET", pattern: /^\/api\/uploads\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/uploads\/[^/]+\/poll$/ },
  { method: "POST", pattern: /^\/api\/uploads\/[^/]+\/retake$/ },
  { method: "GET", pattern: /^\/api\/images\/[^/]+\/original$/ },
  { method: "GET", pattern: /^\/api\/results\/[^/]+\/annotation$/ },
];

const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Total relay request cap, enforced while streaming (never after unbounded
// buffering). The capture image limit is 12 MiB; the allowance covers the
// documented multipart overhead (boundaries, part headers, form fields).
const DEFAULT_MAX_BODY_BYTES = 14 * 1024 * 1024;

export function bodyLimit(env = {}) {
  const raw = Number(env.CAPTURE_MAX_BODY_BYTES);
  return Number.isFinite(raw) && raw >= 65536 ? raw : DEFAULT_MAX_BODY_BYTES;
}

function tooLargeResponse(limitBytes) {
  return jsonError(
    413,
    "request_too_large",
    `The request exceeds the relay limit of ${Math.round(limitBytes / (1024 * 1024))} MiB `
      + "(the 12 MiB image limit plus documented multipart overhead). Nothing was uploaded.",
  );
}

/**
 * Read the request body under a hard byte cap, BEFORE buffering it whole.
 * Handles missing, false and chunked bodies: the declared Content-Length is
 * checked first, and the streamed total is checked regardless of what the
 * client declared.
 */
export async function readBodyCapped(request, limitBytes) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared.trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { rejected: "The request declares an invalid Content-Length." };
    }
    if (parsed > limitBytes) {
      return { tooLarge: true };
    }
  }
  if (!request.body || typeof request.body.getReader !== "function") {
    return { body: new Uint8Array(0) };
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body };
}

function jsonError(status, code, message) {
  return new Response(JSON.stringify({ error: code, detail: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function isProxiedApiRoute(method, pathname) {
  return API_ROUTES.some((route) => route.method === method && route.pattern.test(pathname));
}

function stripHopByHop(headers) {
  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }
  return headers;
}

/**
 * Resolve and validate the backend proxy configuration from the bindings.
 * Returns { origin, relayToken, problems }. `problems` is non-empty when the
 * configuration is missing or unsafe; callers must refuse to forward.
 */
export function resolveBackendConfig(env = {}) {
  const problems = [];
  const isProduction = String(env.CAPTURE_ENVIRONMENT || "").trim().toLowerCase() === "production";

  const rawOrigin = String(env.CAPTURE_BACKEND_ORIGIN || "").trim();
  if (!rawOrigin) {
    problems.push("CAPTURE_BACKEND_ORIGIN is not set; the capture backend host is unknown");
  } else {
    let parsed = null;
    try {
      parsed = new URL(rawOrigin);
    } catch {
      problems.push("CAPTURE_BACKEND_ORIGIN is not a valid URL");
    }
    if (parsed) {
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        problems.push(`CAPTURE_BACKEND_ORIGIN must be http(s), got ${parsed.protocol}`);
      }
      if (parsed.protocol === "http:" && !LOCAL_HTTP_HOSTS.has(parsed.hostname)) {
        problems.push("CAPTURE_BACKEND_ORIGIN may use plain http only for localhost development");
      }
      if (isProduction && parsed.protocol !== "https:") {
        problems.push("CAPTURE_BACKEND_ORIGIN must be https in production");
      }
      if (isProduction && LOCAL_HTTP_HOSTS.has(parsed.hostname)) {
        problems.push("CAPTURE_BACKEND_ORIGIN must not point at localhost in production");
      }
      if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
        problems.push("CAPTURE_BACKEND_ORIGIN must be a bare origin without path, query or fragment");
      }
    }
  }

  const relayToken = String(env.CAPTURE_RELAY_TOKEN || "");
  if (isProduction) {
    if (!relayToken) {
      problems.push("CAPTURE_RELAY_TOKEN is required in production");
    } else if (relayToken.length < 32) {
      problems.push("CAPTURE_RELAY_TOKEN must be at least 32 characters in production");
    }
  }

  return { origin: rawOrigin ? rawOrigin.replace(/\/+$/, "") : "", relayToken, problems };
}

function sanitizeRequestHeaders(requestHeaders, relayToken) {
  const headers = new Headers(requestHeaders);
  for (const name of IDENTITY_HEADERS) {
    headers.delete(name);
  }
  // The browser must never choose the relay credential. A client-supplied
  // Authorization header is removed and replaced with the server-side one.
  headers.delete("authorization");
  headers.delete("host");
  stripHopByHop(headers);
  if (relayToken) {
    headers.set("authorization", `Bearer ${relayToken}`);
  }
  return headers;
}

function sanitizeResponseHeaders(responseHeaders) {
  return stripHopByHop(new Headers(responseHeaders));
}

async function proxyApi(request, config, limitBytes) {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, config.origin);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let body;
  if (hasBody) {
    // Stream under the byte cap before anything is buffered as a whole.
    const read = await readBodyCapped(request, limitBytes);
    if (read.tooLarge) {
      return tooLargeResponse(limitBytes);
    }
    if (read.rejected) {
      return jsonError(400, "bad_request", read.rejected);
    }
    body = read.body;
  }
  const response = await fetch(target, {
    method: request.method,
    headers: sanitizeRequestHeaders(request.headers, config.relayToken),
    body,
    redirect: "manual",
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: sanitizeResponseHeaders(response.headers),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (!isProxiedApiRoute(request.method, url.pathname)) {
        return jsonError(404, "not_found", "This API path is not served by the capture app.");
      }
      const config = resolveBackendConfig(env);
      if (config.problems.length > 0) {
        return jsonError(
          503,
          "backend_not_configured",
          "The capture backend is not configured for this deployment. "
            + config.problems.join(" "),
        );
      }
      try {
        return await proxyApi(request, config, bodyLimit(env));
      } catch {
        return jsonError(
          502,
          "backend_unreachable",
          "The capture backend could not be reached. The photo was not saved; retry the upload.",
        );
      }
    }
    if (!env.ASSETS) {
      return jsonError(500, "assets_binding_missing", "Static asset binding is unavailable.");
    }
    return env.ASSETS.fetch(request);
  },
};
