/**
 * VectorDock field capture page wiring.
 *
 * Flow: sign in -> identify trap (QR URL parameter or manual ID) -> confirm
 * site -> select or create a sample -> photograph -> confirm preview ->
 * automatic upload with a stable idempotency key -> status polling ->
 * reviewer accept/correct/reject.
 *
 * Truthfulness rules:
 * - A saved confirmation appears only after the server responds.
 * - A failed upload or failed count never becomes a zero catch.
 * - A completed count is "pending human review", never accepted by itself.
 * - Nothing is claimed to persist after the page closes.
 */

import { createApiClient, ApiError } from "./lib/api.js";
import { sessionStore } from "./lib/session.js";
import { deriveUploadState, shouldPoll, UI_STATE, stateLabel } from "./lib/status.js";
import { newClientKey, isValidClientKey, captureTimeParts, datetimeLocalParts } from "./lib/idempotency.js";
import { resolvePhotoQr } from "./lib/qr.js";
import { decodePhotoQrPayloads } from "./lib/qr-decoder.js";
import { inspectPhotoFile } from "./lib/image-header.js";

const MAX_BYTES = 12 * 1024 * 1024; // mirrors the backend limit enforced again server-side
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png"]);
const POLL_INTERVAL_MS = 5000;

const api = createApiClient({
  onUnauthorized: () => {
    sessionStore.clearAll();
    state.trap = null;
    state.capture = null;
    state.pendingCapture = null;
    state.uploadId = null;
    renderOperator(null);
    showView("signin");
  },
});

const el = (id) => document.getElementById(id);

const state = {
  operator: null,
  trap: null,
  samples: [],
  // Samples serviced in this session. The trap endpoint lists installed
  // samples only, but the just-removed surface must stay selectable so the
  // worker can photograph it. Revisions come from the PATCH response.
  selectedSampleId: null,
  capture: null, // { file, clientKey, capturedAt, capturedAtOffset, sizeBytes, qr }
  // The retained photo across trap resolution: a photo-first capture keeps
  // the same photo and key until it is confirmed and uploaded. It is never
  // silently attached to a different container.
  pendingCapture: null,
  uploadId: null,
  pollTimer: null,
  expectedSampleRevision: null,
  expectedMeasurementRevision: null,
  reviewEditing: false,
  uploadOffset: 0,
  photoToken: 0,
  dashboardToken: 0,
  forecastToken: 0,
  forecastManualKey: null,
};

/* ------------------------------------------------------------------ views */

const VIEWS = ["signin", "dashboard", "trap", "samples", "capture", "photo-id", "status", "error"];

function showView(name) {
  stopPolling();
  // Any navigation invalidates an in-flight trap lookup: a late response
  // must never overwrite a newer photo or trap decision.
  state.lookupToken = (state.lookupToken || 0) + 1;
  state.photoToken += 1;
  state.dashboardToken += 1;
  state.forecastToken += 1;
  if (name !== "dashboard") {
    el("forecastResult").hidden = true;
    el("forecastResultList").replaceChildren();
    el("forecastLimitations").replaceChildren();
    el("forecastForm").reset();
    el("forecastMonthlyRows").replaceChildren();
    state.forecastManualKey = null;
    el("forecastUploadFields").hidden = false;
    el("forecastManualFields").hidden = true;
    el("forecastRowsMessage").textContent = "Enter the district and last input month first.";
    el("forecastProgress").hidden = true;
    clearError("forecastError");
    setForecastBusy(false);
  }
  for (const view of VIEWS) {
    el(`view-${view}`).hidden = view !== name;
  }
  window.scrollTo(0, 0);
}

function announce(message) {
  el("announcer").textContent = message;
}

function showError(sectionId, message) {
  const node = el(sectionId);
  node.textContent = message;
  node.hidden = false;
}

function clearError(sectionId) {
  const node = el(sectionId);
  node.textContent = "";
  node.hidden = true;
}

function readApiError(error, fallback) {
  if (error instanceof ApiError) {
    return error.detail || fallback;
  }
  return fallback;
}

/* ------------------------------------------------------------------ auth */

function renderOperator(operator) {
  state.operator = operator;
  el("operatorBox").hidden = !operator;
  if (operator) {
    el("operatorName").textContent = operator.display_name || operator.username;
    el("operatorRole").textContent = operator.role;
  }
}

async function boot() {
  const storedOperator = sessionStore.getOperator();
  const storedCsrf = sessionStore.getCsrfToken();
  if (storedOperator && storedCsrf) {
    api.setCsrfToken(storedCsrf);
    try {
      const me = await api.me();
      renderOperator(me.operator);
      await enterAfterLogin(me);
      return;
    } catch {
      sessionStore.clearOperator();
    }
  }
  renderOperator(null);
  showView("signin");
  el("signinUsername").focus();
}

el("signinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError("signinError");
  const username = el("signinUsername").value.trim();
  const password = el("signinPassword").value;
  if (!username || !password) {
    showError("signinError", "Enter the operator name and password.");
    return;
  }
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const body = await api.login(username, password);
    sessionStore.setCsrfToken(body.csrf_token);
    sessionStore.setOperator(body.operator);
    renderOperator(body.operator);
    announce("Signed in.");
    await enterAfterLogin();
  } catch (error) {
    showError("signinError", readApiError(error, "Sign-in failed. Check the name and password."));
  } finally {
    button.disabled = false;
  }
});

el("signOutBtn").addEventListener("click", async () => {
  try {
    await api.logout();
  } catch {
    // sign-out is best effort; the cookie may already be gone
  }
  sessionStore.clearAll();
  state.trap = null;
  state.capture = null;
  state.pendingCapture = null;
  state.uploadId = null;
  el("signinPassword").value = "";
  renderOperator(null);
  showView("signin");
  el("signinUsername").focus();
});

/* --------------------------------------------------------- operator home */

async function enterAfterLogin(me = null) {
  // Preserve QR deep links: they still resolve the named trap after sign-in.
  if (new URLSearchParams(window.location.search).has("trap")) {
    await enterTrapView();
  } else {
    await enterDashboard(me);
  }
}

function textElement(tag, text, className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function enterDashboard(knownMe = null) {
  showView("dashboard");
  const token = state.dashboardToken;
  const list = el("dashboardTrapList");
  const message = el("dashboardTrapMessage");
  list.replaceChildren();
  message.hidden = false;
  message.textContent = "Loading trap details…";
  try {
    const me = knownMe || await api.me();
    if (token !== state.dashboardToken || !state.operator) return;
    const ids = Array.isArray(me.granted_trap_ids) ? me.granted_trap_ids.slice(0, 20) : [];
    if (!ids.length) {
      message.textContent = "No assigned traps are listed. Use the trap lookup to identify one.";
      return;
    }
    const cards = await Promise.allSettled(ids.map(async (id) => {
      const [trap, history] = await Promise.all([
        api.getTrap(id),
        api.getTrapUploads(id, { limit: 1, offset: 0 }),
      ]);
      return { trap, latest: history.items?.[0]?.upload || null };
    }));
    if (token !== state.dashboardToken || !state.operator) return;
    for (const item of cards) {
      if (item.status !== "fulfilled") continue;
      const { trap, latest } = item.value;
      const card = textElement("article", "", "dashboard-trap");
      card.append(textElement("h3", `${trap.trap_id}${trap.is_test_fixture ? " · TEST" : ""}`));
      card.append(textElement("p", `${trap.site_id} · ${trap.district_code}`, "meta"));
      card.append(textElement("p", trap.placement || "No placement recorded", "meta"));
      card.append(textElement("p", trap.active_deployment?.location_note || "No active deployment location", "meta"));
      if (latest) {
        let status = deriveUploadState(latest).label;
        if (typeof latest.result?.candidate_count === "number") {
          status = `${latest.result.candidate_count} candidate detections · ${status}`;
        }
        card.append(textElement("p", `Latest photo: ${status}`));
      } else {
        card.append(textElement("p", "No saved photos for this trap.", "meta"));
      }
      const open = textElement("button", "Open trap", "btn btn-quiet");
      open.type = "button";
      open.addEventListener("click", () => {
        el("trapIdInput").value = trap.trap_id;
        lookupTrap(trap.trap_id);
      });
      card.append(open);
      list.append(card);
    }
    const failed = cards.filter((item) => item.status === "rejected").length;
    message.textContent = failed
      ? `${failed} trap details could not be loaded. Refresh to retry.`
      : `Showing ${ids.length} assigned trap${ids.length === 1 ? "" : "s"}${me.granted_trap_ids.length > ids.length ? " (first 20)" : ""}.`;
  } catch (error) {
    if (token !== state.dashboardToken || !state.operator) return;
    message.textContent = readApiError(error, "Trap details could not be loaded. Refresh to retry.");
  }
}

el("dashboardRefreshBtn").addEventListener("click", () => enterDashboard());
el("dashboardCaptureBtn").addEventListener("click", () => enterTrapView());
el("trapDashboardBtn").addEventListener("click", () => enterDashboard());

function setForecastBusy(busy) {
  for (const control of el("forecastForm").querySelectorAll("input, select, button")) {
    control.disabled = busy;
  }
}

const trainedDistricts = new Map();
function applyDistrictProvince() {
  const district = trainedDistricts.get(el("forecastRegion").value.trim());
  const province = el("forecastProvince");
  if (district && (!province.value || province.value === province.dataset.autoProvince)) {
    province.value = district.province;
    province.dataset.autoProvince = district.province;
  }
}
el("forecastRegion").addEventListener("input", applyDistrictProvince);
el("forecastProvince").addEventListener("input", () => { el("forecastProvince").dataset.autoProvince = ""; });

async function loadTrainedDistricts() {
  try {
    const response = await fetch("/data/forecast-districts.json");
    if (!response.ok) return;
    const districts = await response.json();
    if (!Array.isArray(districts) || districts.length > 1000) return;
    const options = document.createDocumentFragment();
    for (const district of districts) {
      if (!/^\d{2}\.\d{2}$/.test(district.code) || typeof district.name !== "string" || typeof district.province !== "string") continue;
      trainedDistricts.set(district.code, district);
      const option = document.createElement("option");
      option.value = district.code;
      option.label = `${district.name}, ${district.province}`;
      options.append(option);
    }
    el("forecastDistricts").replaceChildren(options);
    applyDistrictProvince();
  } catch {
    // The model still validates a manually entered district and province.
  }
}
void loadTrainedDistricts();

function forecastMonthEnd(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  // A 400-year shift preserves leap years and avoids Date.UTC's 0–99 rule.
  const day = new Date(Date.UTC(2000 + (year % 400), month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(day).padStart(2, "0")}`;
}

function forecastDates(issue) {
  const [year, month] = issue.split("-").map(Number);
  const dates = [];
  for (let offset = 23; offset >= 0; offset -= 1) {
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1 - offset, 1);
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

for (const id of ["forecastSourceCsv", "forecastSourceManual"]) {
  el(id).addEventListener("change", () => {
    const manual = el("forecastSourceManual").checked;
    el("forecastUploadFields").hidden = manual;
    el("forecastManualFields").hidden = !manual;
    clearError("forecastError");
  });
}

el("forecastTemplateBtn").addEventListener("click", () => {
  clearError("forecastError");
  const region = el("forecastRegion").value.trim();
  const issue = forecastMonthEnd(el("forecastMonth").value);
  if (!/^\d{1,2}\.\d{2}$/.test(region) || !issue) {
    showError("forecastError", "Enter a district BPS code and last input month first.");
    return;
  }
  const lines = ["date,bps_kode_2025,cases,province,population,rainfall,tmin,tmax,dry_days,oni,latitude,longitude,mean_mdpl,is_island"];
  for (const date of forecastDates(issue)) {
    lines.push(`${date},${region},,,,,,,,,,,,`);
  }
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `monthly-data-${region}-${issue.slice(0, 7)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const MANUAL_FORECAST_FIELDS = [
  { name: "cases", label: "Reported dengue cases", step: "1", min: "0" },
  { name: "population", label: "District population", step: "1", min: "1" },
  { name: "rainfall", label: "Total rainfall (mm/month)", step: "any", min: "0" },
  { name: "tmin", label: "Mean daily minimum temperature (°C)", step: "any" },
  { name: "tmax", label: "Mean daily maximum temperature (°C)", step: "any" },
  { name: "dry_days", label: "Days with less than 1 mm rain", step: "1", min: "0", max: "31" },
  { name: "oni", label: "ONI temperature anomaly (°C)", step: "any" },
];

el("forecastGenerateBtn").addEventListener("click", () => {
  clearError("forecastError");
  const region = el("forecastRegion").value.trim();
  const issue = forecastMonthEnd(el("forecastMonth").value);
  if (!/^\d{1,2}\.\d{2}$/.test(region) || !issue) {
    showError("forecastError", "Enter a district BPS code and last input month first.");
    return;
  }
  const container = el("forecastMonthlyRows");
  if ([...container.querySelectorAll("input")].some((input) => input.value)
      && !window.confirm("Preparing new months clears the monthly values already entered. Continue?")) return;
  container.replaceChildren();
  forecastDates(issue).forEach((date, index) => {
    const block = document.createElement("details");
    block.className = "monthly-entry";
    block.dataset.date = date;
    block.open = index === 0;
    block.append(textElement("summary", date.slice(0, 7)));
    for (const spec of MANUAL_FORECAST_FIELDS) {
      const field = textElement("div", "", "field");
      const input = document.createElement("input");
      input.type = "number";
      input.id = `forecast-${spec.name}-${index}`;
      input.dataset.field = spec.name;
      input.step = spec.step;
      if (spec.min !== undefined) input.min = spec.min;
      if (spec.max !== undefined) input.max = spec.max;
      const label = textElement("label", spec.label);
      label.htmlFor = input.id;
      field.append(label, input);
      block.append(field);
    }
    container.append(block);
  });
  state.forecastManualKey = `${region}|${issue}`;
  el("forecastRowsMessage").textContent = "24 months prepared. Open each month and enter the values you know. At least 12 months need case counts.";
});

function manualForecastPanel(region, issue) {
  if (state.forecastManualKey !== `${region}|${issue}`) {
    throw new Error("Prepare the 24 months for the selected district and input month.");
  }
  const province = el("forecastProvince").value.trim();
  const island = el("forecastIsland").value;
  if (!province || !["0", "1"].includes(island)) {
    throw new Error("Enter the trained province name and select whether the district is an island.");
  }
  const blocks = [...el("forecastMonthlyRows").querySelectorAll(".monthly-entry")];
  if (blocks.length !== 24) throw new Error("Prepare the 24 months before running a forecast.");
  const csvCell = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const lines = ["date,bps_kode_2025,cases,province,population,rainfall,tmin,tmax,dry_days,oni,latitude,longitude,mean_mdpl,is_island"];
  let observedCases = 0;
  for (const block of blocks) {
    const get = (name) => block.querySelector(`[data-field="${name}"]`).value.trim();
    const cases = get("cases");
    if (cases !== "") observedCases += 1;
    const values = [block.dataset.date, region, cases, province, get("population"), get("rainfall"),
      get("tmin"), get("tmax"), get("dry_days"), get("oni"), el("forecastLatitude").value,
      el("forecastLongitude").value, el("forecastElevation").value, island];
    lines.push(values.map(csvCell).join(","));
  }
  if (observedCases < 12) throw new Error("Enter case counts for at least 12 of the 24 months.");
  return new File([lines.join("\n") + "\n"], "manual-monthly-data.csv", { type: "text/csv" });
}

function renderForecast(result) {
  const list = el("forecastResultList");
  const limitations = el("forecastLimitations");
  list.replaceChildren();
  limitations.replaceChildren();
  el("forecastResultMeta").textContent = `${result.model === "tree" ? "Tree" : "EpiKD"} · district ${result.district} · issued ${result.issue_date}`;
  const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  for (const forecast of result.predictions || []) {
    const card = textElement("article", "", "forecast-month");
    const date = new Date(`${forecast.target_month}T00:00:00Z`);
    const month = Number.isNaN(date.valueOf()) ? forecast.target_month : date.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
    card.append(textElement("h4", month));
    card.append(textElement("p", formatter.format(forecast.expected_cases), "forecast-number"));
    card.append(textElement("p", "expected cases", "meta"));
    const quantiles = forecast.uncertainty?.quantiles || {};
    if (Number.isFinite(quantiles["q0.025"]) && Number.isFinite(quantiles["q0.975"])) {
      card.append(textElement("p", `Model range: ${formatter.format(quantiles["q0.025"])}–${formatter.format(quantiles["q0.975"])}`, "meta"));
    }
    list.append(card);
  }
  for (const limitation of result.limitations || []) {
    limitations.append(textElement("li", limitation));
  }
  el("forecastResult").hidden = false;
}

el("forecastForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError("forecastError");
  el("forecastResult").hidden = true;
  const region = el("forecastRegion").value.trim();
  const issueDate = forecastMonthEnd(el("forecastMonth").value);
  if (!/^\d{1,2}\.\d{2}$/.test(region) || !issueDate) {
    showError("forecastError", "Enter a district BPS code and last input month.");
    return;
  }
  let panel;
  try {
    panel = el("forecastSourceManual").checked
      ? manualForecastPanel(region, issueDate)
      : el("forecastPanel").files?.[0];
  } catch (error) {
    showError("forecastError", error.message || "Check the monthly values before running a forecast.");
    return;
  }
  if (!panel || !panel.size) {
    showError("forecastError", "Choose a nonempty monthly-data CSV.");
    return;
  }
  if (panel.size > 12 * 1024 * 1024) {
    showError("forecastError", "The monthly-data CSV exceeds 12 MiB.");
    return;
  }
  const token = ++state.forecastToken;
  setForecastBusy(true);
  el("forecastProgress").textContent = "Running the forecast. This can take a while…";
  el("forecastProgress").hidden = false;
  try {
    const result = await api.runForecast({ model: el("forecastModel").value, region, issueDate, panel });
    if (token !== state.forecastToken || !state.operator) return;
    renderForecast(result);
    announce("Forecast complete.");
  } catch (error) {
    if (token !== state.forecastToken || !state.operator) return;
    showError("forecastError", readApiError(error, "The forecast could not be run. Check the input and try again."));
  } finally {
    if (token === state.forecastToken) {
      el("forecastProgress").hidden = true;
      setForecastBusy(false);
    }
  }
});

/* ------------------------------------------------------------------ trap */

async function enterTrapView() {
  showView("trap");
  clearError("trapError");
  el("trapCard").hidden = true;
  const params = new URLSearchParams(window.location.search);
  const trapValues = params.getAll("trap").map((value) => value.trim());
  if (trapValues.length > 1) {
    // Any repeated trap parameter is refused, even when the values match.
    showError("trapError", "The page URL carries duplicated or conflicting container IDs. Resolve the container manually.");
  } else if (trapValues.length === 1 && !trapValues[0]) {
    showError("trapError", "The page URL has an empty container ID. Resolve the container manually.");
  } else if (trapValues.length === 1) {
    el("trapIdInput").value = trapValues[0];
    await lookupTrap(trapValues[0]);
  } else {
    const remembered = sessionStore.getTrapId();
    if (remembered) {
      el("trapIdInput").value = remembered;
      await lookupTrap(remembered);
    } else {
      el("trapIdInput").focus();
    }
  }
}

async function lookupTrap(trapId, sourceCapture = null) {
  if (sourceCapture && sourceCapture !== state.capture) return;
  // A lookup may be triggered from the photo-first capture flow; it always
  // shows the resolved registry record on the trap view.
  showView("trap");
  clearError("trapError");
  el("trapCard").hidden = true;
  if (!trapId) {
    showError("trapError", "Enter the trap ID printed on the housing label.");
    return;
  }
  const token = (state.lookupToken = (state.lookupToken || 0) + 1);
  const photoToken = state.photoToken;
  try {
    const trap = await api.getTrap(trapId);
    if (token !== state.lookupToken || photoToken !== state.photoToken || (sourceCapture && sourceCapture !== state.capture)) {
      return; // a newer photo or navigation superseded this lookup
    }
    state.trap = trap;
    state.samples = trap.samples || [];
    state.selectedSampleId = null;
    state.uploadOffset = 0;
    el("trapIdValue").textContent = trap.trap_id;
    el("trapDistrict").textContent = trap.district_code;
    el("trapSite").textContent = trap.site_id;
    el("trapPlacement").textContent = trap.placement;
    const deployment = trap.active_deployment;
    el("trapLocation").textContent = deployment?.location_note || "No registered location note";
    el("trapDeployment").textContent = deployment
      ? `#${deployment.deployment_id} since ${deployment.start_at.slice(0, 10)}${deployment.end_at ? " (closed)" : ""}`
      : "No active deployment";
    el("trapDesign").textContent = trap.trap_design_version;
    el("trapCard").hidden = false;
    announce(`Trap ${trap.trap_id} resolved at site ${trap.site_id}. Confirm the site before capture.`);
    el("trapConfirmBtn").focus();
  } catch (error) {
    if (token !== state.lookupToken || photoToken !== state.photoToken || (sourceCapture && sourceCapture !== state.capture)) {
      return; // a newer photo or navigation superseded this lookup
    }
    if (error instanceof ApiError && error.status === 404) {
      showError("trapError", `Unknown trap ID "${trapId}". Resolve the label with the supervisor before capturing.`);
    } else if (error instanceof ApiError && error.status === 403) {
      showError("trapError", "Your account has no access grant for this trap. Ask an administrator for the grant.");
    } else {
      showError("trapError", readApiError(error, "The trap could not be resolved. Check the connection and retry."));
    }
  }
}

el("trapLookupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  lookupTrap(el("trapIdInput").value.trim().toUpperCase());
});

el("trapRejectBtn").addEventListener("click", () => {
  state.trap = null;
  el("trapCard").hidden = true;
  el("trapIdInput").value = "";
  el("trapIdInput").focus();
});

el("trapConfirmBtn").addEventListener("click", () => {
  if (!state.trap) {
    return;
  }
  state.selectedSampleId = null;
  sessionStore.setTrapId(state.trap.trap_id);
  enterSamplesView();
});

/* ------------------------------------------------------------------ samples */

function formatLocal(iso, offset) {
  if (!iso) {
    return "unknown";
  }
  const suffix = offset && offset !== "+00:00" ? ` (UTC${offset})` : " UTC";
  return `${iso.replace("T", " ").slice(0, 16)}${suffix}`;
}

function sampleSubtitle(sample) {
  const parts = [];
  parts.push(`installed ${formatLocal(sample.installed_at, sample.installed_at_offset)}`);
  if (sample.removed_at) {
    parts.push(`removed ${formatLocal(sample.removed_at, sample.removed_at_offset)}`);
  }
  if (!sample.exposure_known) {
    parts.push("exposure unknown");
  }
  return parts.join(" · ");
}

function sampleBadge(sample) {
  if (sample.awaiting_image || sample.removed_in_session) {
    return "removed — photograph now";
  }
  return sample.sample_type === "adult_card" ? "adult card" : "egg strip";
}

function renderSampleList() {
  const container = el("sampleList");
  container.textContent = "";
  const samples = state.samples;
  el("sampleListEmpty").hidden = samples.length > 0;
  for (const sample of samples) {
    const label = document.createElement("label");
    label.className = "sample-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "sample-select";
    input.value = String(sample.sample_id);
    input.checked = sample.sample_id === state.selectedSampleId;
    input.addEventListener("change", () => {
      state.selectedSampleId = sample.sample_id;
      updateSampleUi();
    });
    const text = document.createElement("span");
    const title = document.createElement("span");
    title.className = "sample-title";
    const badge = document.createElement("span");
    badge.className = "badge badge-cyan";
    badge.textContent = sampleBadge(sample);
    title.appendChild(badge);
    title.appendChild(document.createTextNode(`  #${sample.sample_id}`));
    if (sample.cartridge_id || sample.strip_id) {
      title.appendChild(document.createTextNode(` · ${sample.cartridge_id || sample.strip_id}`));
    }
    const sub = document.createElement("span");
    sub.className = "sample-sub";
    sub.textContent = sampleSubtitle(sample);
    text.appendChild(title);
    text.appendChild(sub);
    label.appendChild(input);
    label.appendChild(text);
    container.appendChild(label);
  }
  updateSampleUi();
}

function selectedSample() {
  return state.samples.find((sample) => sample.sample_id === state.selectedSampleId) || null;
}

function updateSampleUi() {
  const sample = selectedSample();
  el("toCaptureBtn").disabled = !sample;
  el("serviceRevisionBadge").textContent = sample ? `record revision ${sample.revision}` : "";
  el("serviceBlock").disabled = !sample;
  const removedAtInput = el("removedAtInput");
  if (!removedAtInput.value) {
    removedAtInput.value = toDatetimeLocalValue(new Date());
  }
}

function toDatetimeLocalValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function refreshTrapSamples() {
  if (!state.trap) {
    return;
  }
  // Active samples plus removed ones still awaiting a photo: the just
  // serviced surface stays selectable, and a reload cannot lose it because
  // both lists come from the authorized API.
  const [active, awaitingImage] = await Promise.all([
    api.getTrap(state.trap.trap_id),
    api.getTrap(state.trap.trap_id, { sample_state: "awaiting_image", limit: 50 }),
  ]);
  if (active.trap_id !== state.trap.trap_id || awaitingImage.trap_id !== state.trap.trap_id) {
    return; // defensive: ignore responses for a different container
  }
  state.trap = active;
  const samples = [...(active.samples || [])];
  for (const sample of awaitingImage.samples || []) {
    if (!samples.some((item) => item.sample_id === sample.sample_id)) {
      samples.push({ ...sample, awaiting_image: true });
    }
  }
  state.samples = samples;
  if (!state.samples.some((sample) => sample.sample_id === state.selectedSampleId)) {
    state.selectedSampleId = null;
  }
  state.expectedSampleRevision = null;
  renderSampleList();
}

async function enterSamplesView() {
  if (!state.trap) return;
  el("samplesTrapId").textContent = state.trap.trap_id;
  showView("samples");
  renderSampleList();
  try {
    await refreshTrapSamples();
    await refreshSavedUploads();
  } catch (error) {
    showError("savedUploadsError", readApiError(error, "Saved uploads could not be loaded. Retry the list."));
  }
}

async function refreshSavedUploads() {
  if (!state.trap) return;
  const trapId = state.trap.trap_id;
  const token = (state.uploadListToken = (state.uploadListToken || 0) + 1);
  clearError("savedUploadsError");
  const page = await api.getTrapUploads(trapId, { limit: 25, offset: state.uploadOffset });
  if (token !== state.uploadListToken || state.trap?.trap_id !== trapId) return;
  const list = el("savedUploadList");
  list.replaceChildren();
  for (const item of page.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-secondary";
    button.dataset.uploadId = item.upload.upload_id;
    const summary = deriveUploadState(item.upload);
    button.textContent = `Sample #${item.sample.sample_id} · ${item.upload.upload_id.slice(0, 8)} · ${summary.label}`;
    button.addEventListener("click", async () => {
      try {
        const [upload, sample] = await Promise.all([api.getUpload(item.upload.upload_id), api.getSample(item.sample.sample_id)]);
        if (state.trap?.trap_id !== sample.trap_id) return;
        clearCapture();
        state.samples = state.samples.filter((row) => row.sample_id !== sample.sample_id).concat(sample);
        state.selectedSampleId = sample.sample_id;
        state.uploadId = upload.upload_id;
        enterStatusView();
        renderUpload(upload);
      } catch (error) {
        showError("savedUploadsError", readApiError(error, "The saved upload could not be reopened."));
      }
    });
    list.appendChild(button);
  }
  el("savedUploadsSummary").textContent = page.total
    ? `Uploads ${page.offset + 1}–${page.offset + page.items.length} of ${page.total}`
    : "No saved uploads for this trap.";
  el("uploadsPrevBtn").disabled = page.offset === 0;
  el("uploadsNextBtn").disabled = page.offset + page.items.length >= page.total;
}

for (const [id, step] of [["uploadsPrevBtn", -25], ["uploadsNextBtn", 25], ["uploadsRefreshBtn", 0]]) {
  el(id).addEventListener("click", () => {
    state.uploadOffset = Math.max(0, state.uploadOffset + step);
    void refreshSavedUploads().catch((error) => showError("savedUploadsError", readApiError(error, "The upload list could not be refreshed.")));
  });
}

el("samplesBackBtn").addEventListener("click", () => {
  state.trap = null;
  state.selectedSampleId = null;
  clearCapture();
  enterTrapView();
});

el("serviceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError("serviceError");
  const sample = selectedSample();
  if (!sample) {
    showError("serviceError", "Select a sample first.");
    return;
  }
  const parts = datetimeLocalParts(el("removedAtInput").value);
  if (!parts) {
    showError("serviceError", "Enter the removal time.");
    return;
  }
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api.updateSample(sample.sample_id, {
      expected_revision: sample.revision,
      removed_at: parts.capturedAt,
      removed_at_offset: parts.capturedAtOffset,
      condition_notes: el("conditionNotesInput").value.trim(),
      exposure_known: el("exposureKnownInput").checked,
    });
    state.selectedSampleId = sample.sample_id;
    announce(`Sample ${sample.sample_id} marked removed. Photograph the removed surface now.`);
    await refreshTrapSamples();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      showError("serviceError", "The record changed in the meantime. The list was refreshed; check the revision and retry.");
      await refreshTrapSamples().catch(() => {});
    } else {
      showError("serviceError", readApiError(error, "The removal could not be recorded. Retry."));
    }
  } finally {
    button.disabled = false;
  }
});

el("installForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError("installError");
  const parts = datetimeLocalParts(el("installedAtInput").value);
  if (!parts) {
    showError("installError", "Enter the installation time.");
    return;
  }
  const surfaceId = el("surfaceIdInput").value.trim();
  const areaRaw = el("exposedAreaInput").value;
  const sampleType = el("sampleTypeInput").value;
  if (!surfaceId) {
    showError("installError", sampleType === "adult_card"
      ? "Enter the cartridge label printed on the adult card."
      : "Enter the strip label printed on the egg strip.");
    return;
  }
  const payload = {
    sample_type: sampleType,
    installed_at: parts.capturedAt,
    installed_at_offset: parts.capturedAtOffset,
    condition_notes: el("installNotesInput").value.trim(),
  };
  if (sampleType === "adult_card") {
    payload.cartridge_id = surfaceId;
  } else {
    payload.strip_id = surfaceId;
  }
  if (areaRaw) {
    payload.exposed_area_cm2 = Number(areaRaw);
  }
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const sample = await api.createSample(state.trap.trap_id, payload);
    announce(`Sample ${sample.sample_id} created.`);
    el("installForm").reset();
    await refreshTrapSamples();
    state.selectedSampleId = sample.sample_id;
    renderSampleList();
  } catch (error) {
    showError("installError", readApiError(error, "The sample record could not be created. Retry."));
  } finally {
    button.disabled = false;
  }
});

el("toCaptureBtn").addEventListener("click", () => {
  const sample = selectedSample();
  if (!sample) {
    return;
  }
  enterCaptureView(sample);
});

/* ------------------------------------------------------------------ capture */

function enterCaptureView(sample) {
  showView("capture");
  el("captureSampleId").textContent = sample ? `#${sample.sample_id}` : "not selected yet";
  el("captureSampleMeta").textContent = sample
    ? `${sample.sample_type === "adult_card" ? "Adult sticky card" : "Egg strip"} — ${sampleSubtitle(sample)}`
    : "Photo-first identification: the container QR in the photo resolves the registry record. Sample selection follows.";
  clearError("photoError");
  el("photoInput").value = "";
  el("cameraInput").value = "";
  // A retained photo-first capture continues with the same photo and key.
  if (state.pendingCapture) {
    state.capture = state.pendingCapture;
    renderPreview(state.capture);
    void applyQrOutcome(state.capture);
  } else {
    el("previewFigure").hidden = true;
    el("captureActions").hidden = true;
    setQrOutcome(null);
  }
  if (!el("view-capture").hidden) el("cameraInput").focus();
}

function setQrOutcome(message, tone) {
  const node = el("qrOutcome");
  node.textContent = message || "";
  node.hidden = !message;
  node.className = tone === "warn" ? "meta qr-warn" : "meta";
}

function renderPreview(capture) {
  const url = URL.createObjectURL(capture.file);
  const img = el("previewImg");
  img.onload = () => URL.revokeObjectURL(url);
  img.src = url;
  el("previewMeta").textContent = `${capture.file.type}, ${(capture.sizeBytes / 1024 / 1024).toFixed(2)} MiB, captured at ${capture.capturedAt} (UTC${capture.capturedAtOffset})`;
  el("previewFigure").hidden = false;
  el("captureActions").hidden = false;
}

// Shared photo handler: both "Take picture" (camera-preferred input with an
// honest file-picker fallback) and "Upload photo" feed this one path.
async function handlePhotoSelected(file) {
  const token = ++state.photoToken;
  state.lookupToken = (state.lookupToken || 0) + 1;
  state.capture = null;
  state.pendingCapture = null;
  clearError("photoError");
  el("previewFigure").hidden = true;
  el("captureActions").hidden = true;
  setQrOutcome(null);
  if (!file) {
    return;
  }
  // Cheap checks before any decode work; the backend enforces them again.
  if (!ACCEPTED_TYPES.has(file.type)) {
    showError("photoError", "Only JPEG or PNG photos are accepted. HEIC and other formats are refused.");
    return;
  }
  if (file.size > MAX_BYTES) {
    showError("photoError", "The photo is larger than 12 MiB. Reduce the camera resolution and take it again.");
    return;
  }
  let inspected;
  try {
    inspected = await inspectPhotoFile(file);
  } catch (error) {
    if (token === state.photoToken) showError("photoError", error.message);
    return;
  }
  if (token !== state.photoToken) return;
  const now = new Date();
  const parts = captureTimeParts(now);
  // Every selected or captured photo is a new capture with a new key; a
  // retake never reuses an idempotency key.
  const capture = {
    file,
    clientKey: newClientKey(),
    capturedAt: parts.capturedAt,
    capturedAtOffset: parts.capturedAtOffset,
    sizeBytes: file.size,
    qr: null,
  };
  state.capture = capture;
  state.pendingCapture = capture;
  renderPreview(capture);
  announce("Photo selected. Reading the container QR from the photo.");
  el("confirmUploadBtn").disabled = true;
  setQrOutcome("Reading the container QR from the photo…");
  let payloads;
  try {
    payloads = await decodePhotoQrPayloads(file, inspected);
  } catch {
    payloads = [];
    capture.decodeError = "The QR decoder failed on this photo.";
  }
  if (token !== state.photoToken) {
    return; // a newer photo superseded this decode
  }
  capture.qr = resolvePhotoQr(payloads, { ownOrigin: window.location.origin });
  await applyQrOutcome(capture);
}

/** Route the decoded container outcome per QR_PAYLOAD.md and the product rules. */
async function applyQrOutcome(capture) {
  if (capture !== state.capture) return;
  const qr = capture.qr || { status: "no_qr" };
  el("confirmUploadBtn").disabled = false;
  if (state.trap) {
    // Trap-first: the human already confirmed this container explicitly.
    if (qr.status === "trap" && qr.trapId === state.trap.trap_id) {
      setQrOutcome(`Container QR matches ${state.trap.trap_id}.`);
      return;
    }
    if (qr.status === "trap" || qr.status === "conflict") {
      showPhotoIdConflict(qr.status === "trap" ? [state.trap.trap_id, qr.trapId] : qr.ids);
      return;
    }
    // No readable container QR: the confirmed trap stays, stated explicitly.
    setQrOutcome(
      qr.status === "no_qr"
        ? `No container QR is readable in this photo. Continuing with the manually confirmed trap ${state.trap.trap_id} is an explicit human choice.`
        : `${qr.reasons[0]} Continuing with the manually confirmed trap ${state.trap.trap_id} is an explicit human choice.`,
      "warn",
    );
    return;
  }
  // Photo-first: the photo itself must identify the container.
  if (qr.status === "trap") {
    setQrOutcome(`Container QR: ${qr.trapId} — resolving the registry record.`);
    await lookupTrap(qr.trapId, capture);
    return;
  }
  if (qr.status === "conflict") {
    showPhotoIdConflict(qr.ids);
    return;
  }
  showPhotoIdProblem(
    qr.status === "no_qr"
      ? (capture.decodeError || "No container QR is readable in this photo. Retake with the whole label and its white border in frame, or resolve the trap manually.")
      : (qr.reasons[0] || "This QR does not identify a container."),
  );
}

function showPhotoIdConflict(ids) {
  const container = el("photoIdConflictButtons");
  container.textContent = "";
  for (const trapId of ids) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-secondary";
    button.textContent = state.trap && trapId === state.trap.trap_id
      ? `Keep ${trapId} (already confirmed) and continue`
      : `Resolve ${trapId}`;
    button.addEventListener("click", async () => {
      if (state.trap && trapId === state.trap.trap_id) {
        // Explicit human choice to keep the confirmed container.
        showView("capture");
        return;
      }
      await lookupTrap(trapId);
    });
    container.appendChild(button);
  }
  el("photoIdConflict").hidden = false;
  el("photoIdProblem").hidden = true;
  announce("The photo shows conflicting container IDs. Resolve one explicitly.");
  showView("photo-id");
}

function showPhotoIdProblem(message) {
  el("photoIdProblemText").textContent = message;
  el("photoIdProblem").hidden = false;
  el("photoIdConflict").hidden = true;
  announce("The photo does not identify a container. Retake or resolve manually.");
  showView("photo-id");
}

function clearCapture() {
  state.photoToken += 1;
  state.lookupToken = (state.lookupToken || 0) + 1;
  state.capture = null;
  state.pendingCapture = null;
  el("photoInput").value = "";
  el("cameraInput").value = "";
  el("previewFigure").hidden = true;
  el("captureActions").hidden = true;
  setQrOutcome(null);
}

for (const inputId of ["cameraInput", "photoInput"]) {
  el(inputId).addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    void handlePhotoSelected(file);
  });
  el(inputId).addEventListener("cancel", () => { void handlePhotoSelected(null); });
}

el("photoFirstBtn").addEventListener("click", () => {
  // Photo-first identification: no container needs to be selected before a
  // photo is taken; the QR inside the photo resolves the registry record.
  clearCapture();
  state.trap = null;
  state.selectedSampleId = null;
  enterCaptureView(null);
});

el("captureBackBtn").addEventListener("click", () => {
  // Back never discards the retained photo silently; it only navigates.
  if (state.selectedSampleId && selectedSample()) {
    enterSamplesView();
  } else {
    enterTrapView();
  }
});

el("retakeBtn").addEventListener("click", () => {
  clearCapture();
  el("cameraInput").focus();
});

el("photoIdConflictRetakeBtn").addEventListener("click", () => {
  clearCapture();
  showView("capture");
  el("cameraInput").focus();
});

el("photoIdProblemRetakeBtn").addEventListener("click", () => {
  clearCapture();
  showView("capture");
  el("cameraInput").focus();
});

el("photoIdManualBtn").addEventListener("click", () => {
  // Explicit manual fallback; the retained photo is never silently bound to
  // a container. The human resolves and confirms the container next.
  showView("trap");
  el("trapCard").hidden = true;
  el("trapIdInput").focus();
});

el("confirmUploadBtn").addEventListener("click", () => {
  const capture = state.capture;
  if (!capture || !state.selectedSampleId) {
    return;
  }
  const qr = capture.qr;
  if (qr && qr.status === "trap" && state.trap && qr.trapId !== state.trap.trap_id) {
    // A photo of a different container must never upload to this sample.
    showPhotoIdConflict([state.trap.trap_id, qr.trapId]);
    return;
  }
  void startUpload(false);
});

async function startUpload(isRetry) {
  const capture = state.capture;
  if (!capture || !isValidClientKey(capture.clientKey)) {
    showError("photoError", "No photo is ready for upload.");
    return;
  }
  clearError("photoError");
  clearError("statusError");
  enterStatusView();
  setStatusBanner(UI_STATE.SAVING, "Saving photo…", "busy", "Sending the confirmed photo to the capture service.");
  try {
    const upload = await api.submitImage(state.selectedSampleId, {
      clientKey: capture.clientKey,
      capturedAt: capture.capturedAt,
      capturedAtOffset: capture.capturedAtOffset,
      file: capture.file,
    });
    state.uploadId = upload.upload_id;
    state.pendingCapture = null; // the photo is on the server; a retry reuses the stored key
    renderUpload(upload);
  } catch (error) {
    state.uploadId = null;
    const conflict = error instanceof ApiError && error.status === 409;
    showUploadFailure(
      conflict
        ? "This photo conflicts with an earlier upload under the same tracking key. Take the photo again (a retake uses a new key)."
        : readApiError(error, "The upload failed. The photo was not saved. Retry keeps the same photo and tracking key."),
    );
    if (!isRetry) {
      announce("Upload failed.");
    }
  }
}

/* ------------------------------------------------------------------ status */

function enterStatusView() {
  state.reviewEditing = false;
  el("reviewEditBtn").hidden = true;
  el("statusSampleId").textContent = `#${state.selectedSampleId}`;
  el("resultBlock").hidden = true;
  el("reviewBlock").hidden = true;
  el("uploadRetryActions").hidden = true;
  showView("status");
}

function setStatusBanner(stateKey, label, tone, detail) {
  const banner = el("statusBanner");
  banner.textContent = label;
  banner.className = `status-banner tone-${tone}`;
  banner.dataset.state = stateKey;
  el("statusDetail").textContent = detail || "";
}

function showUploadFailure(detail) {
  setStatusBanner(UI_STATE.FAILED_UPLOAD, stateLabel(UI_STATE.FAILED_UPLOAD), "error", detail);
  el("uploadRetryActions").hidden = false;
  el("resultBlock").hidden = true;
  el("reviewBlock").hidden = true;
  el("statusError").hidden = true;
}

function renderUpload(upload) {
  const derived = deriveUploadState(upload);
  setStatusBanner(derived.state, derived.label, derived.tone, derived.detail);
  const failed = derived.state === UI_STATE.FAILED_UPLOAD || derived.state === UI_STATE.FAILED_PROCESSING;
  el("uploadRetryActions").hidden = !(failed || derived.state === UI_STATE.NEEDS_ATTENTION);
  // A failed upload can resend the same photo and key. A failed count has the
  // photo already stored; only a retake (new key) makes sense from the phone.
  el("retryUploadBtn").hidden = derived.state !== UI_STATE.FAILED_UPLOAD;
  announce(derived.label);

  const showResult = Boolean(upload.result) && upload.processing && upload.processing.state === "completed";
  el("resultBlock").hidden = !showResult;
  if (showResult) {
    state.pendingReviewImageId = upload.image_id;
    el("candidateCount").textContent = String(upload.result.candidate_count);
    el("reviewedCount").textContent = upload.review?.accepted_count == null ? "No accepted count for this photo" : String(upload.review.accepted_count);
    el("capturedAtOut").textContent = formatLocal(upload.captured_at, null);
    el("uploadIdOut").textContent = upload.upload_id;
    const img = el("annotationImg");
    const url = new URL(upload.result.annotation_url, window.location.href);
    img.src = url.pathname + url.search; // same-origin path through the proxy
    el("originalLink").href = `/api/images/${upload.image_id}/original`;
  }

  renderReviewBlock(upload, derived);
  if (shouldPoll(derived)) {
    startPolling(upload.upload_id);
  } else {
    stopPolling();
  }
}

function renderReviewBlock(upload, derived) {
  const isReviewer = state.operator && (state.operator.role === "reviewer" || state.operator.role === "admin");
  const review = upload.review || {};
  state.pendingReviewCandidate = (upload.result && upload.processing && upload.processing.state === "completed")
    ? upload.result.candidate_count
    : null;
  const active = review.sample_active || null;
  const sample = state.samples.find((item) => item.sample_id === state.selectedSampleId);
  if (sample) {
    state.expectedSampleRevision = sample.revision;
  }
  // The expected revision for the next explicit review is always the
  // SAMPLE's active measurement (any image, any decision). This image's own
  // historical measurement (review.measurement_revision) is informational:
  // a new review supersedes the sample's active measurement.
  state.expectedMeasurementRevision = active ? active.revision : null;
  // Server-side zero eligibility: a confirmed zero requires a completed
  // exposure (recorded removal time and known usable exposure). The UI
  // pre-checks this; the server derives and enforces it again.
  state.zeroAllowed = Boolean(sample && sample.removed_at && sample.exposure_known);
  const hasCandidate = state.pendingReviewCandidate !== null;
  const reviewed = derived.state === UI_STATE.ACCEPTED || derived.state === UI_STATE.REJECTED;
  el("reviewEditBtn").hidden = !(reviewed && isReviewer && hasCandidate && !state.reviewEditing);
  const showReview = isReviewer && upload.image_id && hasCandidate && (derived.state === UI_STATE.PENDING_REVIEW || state.reviewEditing);
  el("reviewBlock").hidden = !showReview;
  if (!showReview) {
    return;
  }
  el("correctedCountInput").value = state.reviewEditing && review.accepted_count != null ? String(review.accepted_count) : "";
  el("rejectionReasonField").hidden = true;
  el("decisionAccept").checked = true;
  const contextParts = ["Accept the candidate count, correct it, or reject the sample with a reason. Rejection records no count."];
  if (active && active.image_id !== upload.image_id) {
    const prior = active.decision === "accepted" ? "an accepted measurement" : "a rejected review";
    contextParts.push(`This sample has ${prior} from a different photo (revision ${active.revision}); a review here replaces it explicitly.`);
  } else if (active) {
    const prior = active.decision === "accepted" ? "accepted measurement" : "rejected review";
    contextParts.push(`This corrects the active ${prior} (revision ${active.revision}) of this photo.`);
  }
  el("reviewContext").textContent = contextParts.join(" ");
  el("correctedCountInput").placeholder = state.pendingReviewCandidate === null
    ? "candidate count unavailable"
    : String(state.pendingReviewCandidate);
  const revisionTexts = [`Expected sample record revision: ${state.expectedSampleRevision ?? "unknown — refresh"}.`];
  if (active) {
    revisionTexts.push(`Expected measurement revision (active): ${active.revision}.`);
  } else {
    revisionTexts.push("This is the first measurement for the sample.");
  }
  if (!state.zeroAllowed) {
    revisionTexts.push("A confirmed zero is impossible for this sample: no recorded removal time or unknown exposure. Accepting zero will be refused.");
  }
  el("revisionNote").textContent = revisionTexts.join(" ");
}

el("decisionAccept").addEventListener("change", () => {
  el("correctedCountField").hidden = false;
  el("rejectionReasonField").hidden = true;
});
el("decisionReject").addEventListener("change", () => {
  el("correctedCountField").hidden = true;
  el("rejectionReasonField").hidden = false;
  el("rejectionReasonInput").focus();
});

el("reviewRefreshBtn").addEventListener("click", async () => {
  clearError("reviewError");
  await refreshReviewContext();
});

async function refreshReviewContext() {
  try {
    const sample = await api.getSample(state.selectedSampleId);
    state.samples = state.samples.filter((row) => row.sample_id !== sample.sample_id).concat(sample);
    state.expectedSampleRevision = sample.revision;
    if (state.uploadId) {
      const upload = await api.getUpload(state.uploadId);
      renderUpload(upload);
    }
  } catch (error) {
    showError("reviewError", readApiError(error, "The revision could not be refreshed. Retry."));
  }
}

el("reviewEditBtn").addEventListener("click", async () => {
  state.reviewEditing = true;
  await refreshReviewContext();
  if (!el("reviewBlock").hidden) el("correctedCountInput").focus();
});

el("reviewForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError("reviewError");
  const decision = el("decisionReject").checked ? "rejected" : "accepted";
  const payload = {
    expected_sample_revision: state.expectedSampleRevision,
    expected_measurement_revision: state.expectedMeasurementRevision,
    image_id: state.pendingReviewImageId,
    decision,
    usable_exposure: el("reviewUsableExposure").checked,
  };
  if (decision === "accepted") {
    const raw = el("correctedCountInput").value.trim();
    let acceptedCount = null;
    if (raw !== "") {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        showError("reviewError", "The accepted count must be a whole number of 0 or more.");
        return;
      }
      acceptedCount = parsed;
      payload.corrected_count = parsed;
    } else if (state.pendingReviewCandidate !== null && state.pendingReviewCandidate !== undefined) {
      acceptedCount = state.pendingReviewCandidate;
    }
    if (acceptedCount === 0 && state.zeroAllowed === false) {
      showError("reviewError", "A confirmed zero requires a completed exposure: the sample must have a recorded removal time and known usable exposure. Record the removal or reject the sample instead.");
      return;
    }
  } else {
    const reason = el("rejectionReasonInput").value.trim();
    if (!reason) {
      showError("reviewError", "A rejected review needs a reason.");
      return;
    }
    payload.rejection_reason = reason;
  }
  if (!Number.isInteger(payload.expected_sample_revision)) {
    showError("reviewError", "The current sample revision is unknown. Refresh the revision and retry.");
    return;
  }
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api.createReview(state.selectedSampleId, payload);
    state.reviewEditing = false;
    announce("Review submitted.");
    const upload = await api.getUpload(state.uploadId);
    renderUpload(upload);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      showError("reviewError", "The record changed while you reviewed. Refresh the revision, check the candidate again, then retry.");
    } else {
      showError("reviewError", readApiError(error, "The review could not be submitted. Retry."));
    }
  } finally {
    button.disabled = false;
  }
});

el("retryUploadBtn").addEventListener("click", () => {
  void startUpload(true);
});

el("retakeFromStatusBtn").addEventListener("click", async () => {
  if (el("statusBanner").dataset.state === UI_STATE.NEEDS_ATTENTION) {
    if (!window.confirm("The saved job stays stopped. Ask a supervisor before taking a new photo. Continue with an audited retake for this same sample? A new photo and confirmation are required; this does not restart the old job.")) return;
    const uploadId = state.uploadId;
    const sampleId = state.selectedSampleId;
    const token = state.photoToken;
    el("retakeFromStatusBtn").disabled = true;
    try {
      const result = await api.requestAttentionRetake(uploadId);
      if (state.uploadId !== uploadId || state.selectedSampleId !== sampleId || token !== state.photoToken) return;
      if (result.sample_id !== sampleId) throw new Error("Retake sample mismatch");
    } catch (error) {
      showError("statusError", readApiError(error, "The retake request could not be recorded. Refresh the job before retrying."));
      return;
    } finally {
      el("retakeFromStatusBtn").disabled = false;
    }
  }
  clearCapture();
  const sample = selectedSample();
  if (sample) {
    enterCaptureView(sample);
  } else {
    enterSamplesView();
  }
});

el("statusBackBtn").addEventListener("click", async () => {
  clearCapture();
  await enterSamplesView();
});

/* ------------------------------------------------------------------ polling */

function startPolling(uploadId) {
  if (state.pollTimer) {
    return; // one timer only; no duplicate submission or duplicate polling
  }
  let inFlight = false;
  const timer = setInterval(async () => {
    if (state.pollTimer !== timer || state.uploadId !== uploadId) {
      return;
    }
    if (inFlight) return;
    inFlight = true;
    try {
      // Check only the existing retained call. This never starts inference.
      const upload = await api.pollUpload(uploadId);
      if (state.pollTimer !== timer || state.uploadId !== uploadId) return;
      const derived = deriveUploadState(upload);
      // The banner is only rewritten on actual changes to avoid chatter.
      if (el("statusBanner").dataset.state !== derived.state) {
        renderUpload(upload);
      }
      if (!shouldPoll(derived)) {
        stopPolling();
      }
    } catch {
      // transient polling errors keep the last known state; the banner stays honest
    } finally {
      inFlight = false;
    }
  }, POLL_INTERVAL_MS);
  state.pollTimer = timer;
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

/* ------------------------------------------------------------------ error view */

function showGlobalError(message) {
  el("globalError").textContent = message;
  showView("error");
}

el("errorRetryBtn").addEventListener("click", () => {
  void boot();
});

/* ------------------------------------------------------------------ boot */

window.addEventListener("pageshow", () => {
  void boot().catch((error) => {
    showGlobalError(readApiError(error, "The capture service is unavailable right now."));
  });
});
