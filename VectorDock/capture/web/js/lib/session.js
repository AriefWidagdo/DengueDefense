/**
 * Tab-scoped session state (sessionStorage).
 *
 * Only non-secret display state is stored: the signed-in operator summary and
 * the CSRF token returned by the login response. The session cookie itself is
 * HttpOnly and is managed by the browser. The photo File object and the
 * idempotency key live only in page memory; nothing here claims offline
 * persistence after the page closes.
 */

const PREFIX = "vd.capture.";

function set(key, value) {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode): state stays in memory for this page
  }
}

function get(key) {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function remove(key) {
  try {
    sessionStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

export const sessionStore = {
  setOperator(operator) {
    set("operator", operator);
  },
  getOperator() {
    return get("operator");
  },
  clearOperator() {
    remove("operator");
    remove("csrf");
  },
  setCsrfToken(token) {
    set("csrf", token);
  },
  getCsrfToken() {
    return get("csrf");
  },
  clearAll() {
    for (const key of ["operator", "csrf", "trapId", "sampleId"]) {
      remove(key);
    }
  },
  setTrapId(trapId) {
    set("trapId", trapId);
  },
  getTrapId() {
    return get("trapId");
  },
  setSampleId(sampleId) {
    set("sampleId", sampleId);
  },
  getSampleId() {
    return get("sampleId");
  },
};
