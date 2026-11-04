import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient } from "../js/lib/api.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("forecast sends multipart data and the signed-in CSRF token", async () => {
  let captured;
  const api = createApiClient({ fetchImpl: async (url, init) => {
    captured = { url, init };
    return json({ model: "tree", predictions: [] });
  }});
  api.setCsrfToken("test-csrf");
  const file = new File(["month,cases\n"], "monthly.csv", { type: "text/csv" });
  await api.runForecast({ model: "tree", region: "31.73", issueDate: "2024-06-30", panel: file });
  assert.equal(captured.url, "/api/forecasts");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.get("x-csrf-token"), "test-csrf");
  assert.equal(captured.init.body.get("model"), "tree");
  assert.equal(captured.init.body.get("region"), "31.73");
  assert.equal(captured.init.body.get("issue_date"), "2024-06-30");
  assert.equal(await captured.init.body.get("panel").text(), "month,cases\n");
});

test("a stale 401 cannot sign out a later operator", async () => {
  let finishOld;
  let calls = 0;
  let unauthorized = 0;
  const oldResponse = new Promise((resolve) => { finishOld = resolve; });
  const api = createApiClient({
    onUnauthorized: () => { unauthorized += 1; },
    fetchImpl: async (url) => {
      if (url === "/api/auth/login") return json({ csrf_token: `csrf-${++calls}`, operator: {} });
      if (url === "/api/auth/logout") return new Response(null, { status: 204 });
      if (url === "/api/forecasts") return oldResponse;
      throw new Error("unexpected request");
    },
  });
  await api.login("first", "password");
  const old = api.runForecast({ model: "tree", region: "31.73", issueDate: "2024-06-30", panel: new File(["x"], "x.csv") });
  await api.logout();
  await api.login("second", "password");
  finishOld(json({ detail: "old session expired" }, 401));
  await assert.rejects(old);
  assert.equal(unauthorized, 0);
  assert.equal(api.getCsrfToken(), "csrf-2");
});
