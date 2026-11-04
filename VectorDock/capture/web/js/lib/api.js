/**
 * Small same-origin API client for the VectorDock capture backend.
 *
 * All requests go to same-origin `/api` paths: in production the Cloudflare
 * Pages worker proxies them to the backend, in local development the dev
 * server does the same. The browser never talks to the backend host directly
 * and never sees the relay credential.
 *
 * Auth flow (backend app/security.py):
 * - POST /api/auth/login sets the HttpOnly session cookie and returns a CSRF
 *   token in the body.
 * - Every cookie-authenticated write must send that token as X-CSRF-Token.
 * - The relay credential is a server-to-server transport credential inside
 *   the worker binding; it is not an end-user identity and never appears here.
 */

export class ApiError extends Error {
  constructor(status, code, detail) {
    super(detail || code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail || code;
  }
}

function extractDetail(status, bodyText) {
  try {
    const body = JSON.parse(bodyText);
    if (typeof body.detail === "string") {
      return body.detail;
    }
    if (Array.isArray(body.detail)) {
      return body.detail
        .map((item) => {
          const loc = Array.isArray(item.loc) ? item.loc.join(".") : "";
          return `${loc}: ${item.msg || "invalid value"}`;
        })
        .join("; ");
    }
    if (typeof body.detail === "object" && body.detail !== null) {
      return JSON.stringify(body.detail);
    }
    if (typeof body.error === "string" && typeof body.detail === "string") {
      return `${body.error}: ${body.detail}`;
    }
  } catch {
    // fall through to raw text
  }
  return bodyText ? bodyText.slice(0, 300) : `HTTP ${status}`;
}

export function createApiClient({ fetchImpl = globalThis.fetch, onUnauthorized = null } = {}) {
  let csrfToken = null;
  let authGeneration = 0;

  async function request(method, path, { json = undefined, form = undefined, expect = [] } = {}) {
    const requestGeneration = authGeneration;
    const headers = new Headers();
    if (json !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (csrfToken) {
      headers.set("x-csrf-token", csrfToken);
    }
    let response;
    try {
      response = await fetchImpl(path, {
        method,
        headers,
        body: json !== undefined ? JSON.stringify(json) : form,
        credentials: "same-origin",
      });
    } catch (error) {
      throw new ApiError(0, "network_error", "The capture service could not be reached. Check the connection and retry.");
    }
    if (response.status === 401 && onUnauthorized && requestGeneration === authGeneration) {
      csrfToken = null;
      authGeneration += 1;
      onUnauthorized();
    }
    if (expect.length > 0 && !expect.includes(response.status)) {
      throw new ApiError(response.status, "http_error", extractDetail(response.status, await response.text()));
    }
    if (response.status === 204) {
      return null;
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      if (!response.ok) {
        throw new ApiError(response.status, "http_error", extractDetail(response.status, await response.text()));
      }
      return response;
    }
    const body = await response.json();
    if (!response.ok) {
      throw new ApiError(response.status, "http_error", extractDetail(response.status, JSON.stringify(body)));
    }
    return body;
  }

  return {
    setCsrfToken(token) {
      if (token !== csrfToken) authGeneration += 1;
      csrfToken = token;
    },
    getCsrfToken() {
      return csrfToken;
    },
    async login(username, password) {
      const body = await request("POST", "/api/auth/login", {
        json: { username, password },
        expect: [200],
      });
      authGeneration += 1;
      csrfToken = body.csrf_token;
      return body;
    },
    logout() {
      // Start logout with the old token, then invalidate all earlier requests.
      const pending = request("POST", "/api/auth/logout", { expect: [204] });
      authGeneration += 1;
      csrfToken = null;
      return pending;
    },
    me() {
      return request("GET", "/api/auth/me", { expect: [200] });
    },
    health() {
      return request("GET", "/api/health", { expect: [200] });
    },
    runForecast({ model, region, issueDate, panel }) {
      const form = new FormData();
      form.set("model", model);
      form.set("region", region);
      form.set("issue_date", issueDate);
      form.set("panel", panel, panel.name || "monthly-data.csv");
      return request("POST", "/api/forecasts", { form, expect: [200] });
    },
    getTrap(trapId, params = null) {
      let path = `/api/traps/${encodeURIComponent(trapId)}`;
      if (params) {
        const query = new URLSearchParams(params).toString();
        if (query) {
          path += `?${query}`;
        }
      }
      return request("GET", path, { expect: [200] });
    },
    getTrapUploads(trapId, { limit = 25, offset = 0 } = {}) {
      return request("GET", `/api/traps/${encodeURIComponent(trapId)}/uploads?limit=${limit}&offset=${offset}`, { expect: [200] });
    },
    getSample(sampleId) {
      return request("GET", `/api/samples/${sampleId}`, { expect: [200] });
    },
    createSample(trapId, payload) {
      return request("POST", `/api/traps/${encodeURIComponent(trapId)}/samples`, {
        json: payload,
        expect: [201],
      });
    },
    updateSample(sampleId, payload) {
      return request("PATCH", `/api/samples/${sampleId}`, { json: payload, expect: [200] });
    },
    submitImage(sampleId, { clientKey, capturedAt, capturedAtOffset, file }) {
      const form = new FormData();
      form.set("client_key", clientKey);
      form.set("captured_at", capturedAt);
      form.set("captured_at_offset", capturedAtOffset);
      form.set("file", file, file.name || "capture.jpg");
      // 200 = idempotent replay of the same key+content, 202 = new upload.
      // 409 (key conflict) throws with the backend's readable detail.
      return request("POST", `/api/samples/${sampleId}/images`, { form, expect: [200, 202] });
    },
    getUpload(uploadId) {
      return request("GET", `/api/uploads/${encodeURIComponent(uploadId)}`, { expect: [200] });
    },
    pollUpload(uploadId) {
      return request("POST", `/api/uploads/${encodeURIComponent(uploadId)}/poll`, { expect: [200] });
    },
    requestAttentionRetake(uploadId) {
      return request("POST", `/api/uploads/${encodeURIComponent(uploadId)}/retake`, { expect: [201] });
    },
    createReview(sampleId, payload) {
      // 409 stale revision and 422 invalid review throw with readable detail.
      return request("POST", `/api/samples/${sampleId}/reviews`, { json: payload, expect: [201] });
    },
  };
}
