/* Local-only container label maker. No analytics, external QR API, or upload. */
(function () {
  "use strict";
  const STORE_KEY = "vectordock-container-labels-v1";
  const DRAFT_KEY = "vectordock-container-label-draft-v1";
  const FIELDS = ["trap_id", "site", "location", "deployed_on", "service_on", "latitude", "longitude", "setup", "note", "mode"];
  const SETUPS = ["", "Adult card + egg strip", "Adult card", "Egg strip"];
  const MODE_TITLES = { identity: "Bucket ID QR", details: "Details QR", maps: "Maps QR" };
  function localToday() {
    const date = new Date();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }
  function clean(value) { return String(value == null ? "" : value).replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").trim(); }
  function normalize(raw) {
    const row = {};
    for (const field of FIELDS) row[field] = clean(raw[field]);
    row.trap_id = row.trap_id.toUpperCase();
    row.mode = row.mode || "identity";
    return row;
  }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return y >= 1900 && y <= 2200 && date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  }
  function validate(raw) {
    const row = normalize(raw);
    if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(row.trap_id)) return "Enter a container ID with 2–40 letters, numbers or hyphens.";
    if (!row.site || row.site.length > 70) return "Enter a site name, up to 70 characters.";
    if (!row.location || row.location.length > 140) return "Enter an exact location, up to 140 characters.";
    if (!validDate(row.deployed_on)) return "Enter a valid deployment date (1900–2200).";
    if (row.service_on && (!validDate(row.service_on) || row.service_on < row.deployed_on)) return "The service date must be on or after the deployment date.";
    if (Boolean(row.latitude) !== Boolean(row.longitude)) return "Enter both latitude and longitude, or leave both blank.";
    if (row.latitude) {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(row.latitude) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(row.longitude)) return "Use decimal numbers for GPS coordinates.";
      if (Math.abs(Number(row.latitude)) > 90 || Math.abs(Number(row.longitude)) > 180) return "Latitude must be −90 to 90; longitude must be −180 to 180.";
    }
    if (!SETUPS.includes(row.setup)) return "Choose one of the listed container setups.";
    if (row.note.length > 100) return "Keep the placement note to 100 characters.";
    if (!["identity", "details", "maps"].includes(row.mode)) return "Choose bucket ID, details or Maps mode.";
    return "";
  }
  function buildPayload(raw) {
    const row = normalize(raw);
    const error = validate(row);
    if (error) throw new Error(error);
    if (row.mode === "identity") return `VD1:TRAP:${row.trap_id}`;
    if (row.mode === "maps") {
      const query = row.latitude ? `${Number(row.latitude)},${Number(row.longitude)}` : `${row.location}, ${row.site}`;
      const url = new URL("https://www.google.com/maps/search/");
      url.searchParams.set("api", "1");
      url.searchParams.set("query", query);
      return url.href;
    }
    const lines = ["VECTORDOCK CONTAINER", `ID: ${row.trap_id}`, `Site: ${row.site}`, `Location: ${row.location}`, `Deployed: ${row.deployed_on}`];
    if (row.latitude) lines.push(`GPS: ${row.latitude}, ${row.longitude}`);
    if (row.service_on) lines.push(`Service due: ${row.service_on}`);
    if (row.setup) lines.push(`Setup: ${row.setup}`);
    if (row.note) lines.push(`Placement: ${row.note}`);
    lines.push("Printed snapshot. Not a live registry.");
    const payload = lines.join("\n");
    if (new TextEncoder().encode(payload).length > 900) throw new Error("Shorten the location or placement note so the printed QR stays readable.");
    return payload;
  }
  const helpers = { normalize, validate, validDate, buildPayload, localToday };
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;
  window.VectorDockLabels = Object.freeze(helpers);
  const form = document.getElementById("label-form");
  const preview = document.getElementById("preview");
  const printArea = document.getElementById("print-area");
  const errorBox = document.getElementById("form-error");
  const printButton = document.getElementById("print-current");
  const saveButton = document.getElementById("save-label");
  const status = document.getElementById("storage-status");
  const scanStatus = document.getElementById("scan-status");
  let saved = [];
  let current = null;
  let printSource = "current";
  let storageAvailable = true;
  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function readForm() { return normalize(Object.fromEntries(new FormData(form).entries())); }
  function makeQR(payload) {
    if (typeof qrcode !== "function") throw new Error("The local QR library did not load. Keep the vendor folder beside this page and refresh.");
    qrcode.stringToBytes = (value) => Array.from(new TextEncoder().encode(value));
    const code = qrcode(0, "Q");
    code.addData(payload, "Byte");
    code.make();
    const holder = node("div", null, "qr-mark");
    // This SVG comes only from the pinned local encoder. User strings are encoded as QR modules, not HTML.
    holder.innerHTML = code.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
    holder.setAttribute("role", "img");
    holder.setAttribute("aria-label", "QR code for the container");
    return holder;
  }
  function label(raw) {
    const row = normalize(raw);
    const payload = buildPayload(row);
    const card = node("article", null, "container-label");
    const brand = node("div", null, "label-brand");
    brand.append(node("span", "VECTORDOCK"), node("span", "CONTAINER"));
    card.append(brand, node("div", row.trap_id, "label-id"), node("p", row.site, "label-site"), node("p", row.location, "label-location"), makeQR(payload));
    const caption = { identity: "INCLUDE THIS QR IN THE CAPTURE PHOTO", details: "SCAN TO READ CONTAINER DETAILS", maps: "SCAN TO OPEN THE LOCATION" };
    card.append(node("p", caption[row.mode], "label-caption"));
    const meta = node("div", null, "label-meta");
    for (const [title, value] of [["Deployed", row.deployed_on], ["Service due", row.service_on || "Not set"]]) {
      const cell = node("div");
      cell.append(node("span", title), node("strong", value));
      meta.append(cell);
    }
    card.append(meta);
    if (row.latitude) card.append(node("p", `GPS ${row.latitude}, ${row.longitude}`, "label-gps"));
    if (row.setup) card.append(node("p", row.setup, "label-note"));
    if (row.note) card.append(node("p", row.note, "label-note"));
    const footer = {
      identity: "Bucket ID for VectorDock photo capture. Register this ID in the app. Printed site and dates are a snapshot.",
      details: "Text QR: use a reader that displays text. Printed snapshot; reprint if details change.",
      maps: "Maps QR: location only, not a bucket identifier. Reprint if the container moves."
    };
    card.append(node("p", footer[row.mode], "label-footer"));
    return card;
  }
  function storageWarning(message) { storageAvailable = false; status.textContent = message; }
  function persistDraft(row) {
    if (!storageAvailable) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(row)); }
    catch (_) { storageWarning("Browser storage is unavailable. You can still print. Export your label list before closing."); }
  }
  function render() {
    const row = readForm();
    persistDraft(row);
    const validationError = validate(row);
    printButton.disabled = Boolean(validationError);
    saveButton.disabled = Boolean(validationError);
    if (validationError) {
      current = null;
      document.getElementById("payload").textContent = "Complete the required fields to generate a QR.";
      scanStatus.textContent = validationError;
      preview.replaceChildren(node("div", validationError, "empty-preview"));
      return;
    }
    try {
      const card = label(row);
      current = row;
      preview.replaceChildren(card);
      document.getElementById("payload").textContent = buildPayload(row);
      errorBox.hidden = true;
      const modeStatus = {
        identity: "Bucket ID mode: put this QR in the same photo as the collection surface. The capture app must read this ID and find its registered location. This local label list is not synced to that registry. The QR does not open a website.",
        details: "Details mode: the QR stores a text snapshot. The capture app can extract its ID, but must look up the current location in the registry. Use bucket ID mode for a shorter, clearer capture QR.",
        maps: "Maps mode: opens a Google Maps location, but contains no bucket ID. It cannot automatically assign a mosquito photo to a bucket. Google receives the location when the link opens."
      };
      scanStatus.textContent = modeStatus[row.mode];
    } catch (error) {
      current = null;
      printButton.disabled = true;
      saveButton.disabled = true;
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  }
  function fill(row) {
    for (const field of FIELDS) {
      if (field === "mode") continue;
      form.elements.namedItem(field).value = row[field] || "";
    }
    const mode = ["identity", "details", "maps"].includes(row.mode) ? row.mode : "identity";
    form.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
    render();
  }
  function persistSaved() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); }
    catch (_) { storageWarning("Could not save to browser storage. Your list stays open in this tab. Use Export JSON before closing."); }
  }
  function renderSaved() {
    const list = document.getElementById("saved-list");
    list.replaceChildren();
    document.getElementById("saved-count").textContent = String(saved.length);
    document.getElementById("print-saved").disabled = !saved.length;
    document.getElementById("export-labels").disabled = !saved.length;
    if (!saved.length) list.append(node("p", "Save a label to prepare several containers.", "subtle"));
    for (const row of saved) {
      const item = node("div", null, "saved-item");
      const info = node("div", null, "saved-info");
      info.append(node("strong", `${row.trap_id} · ${row.site}`), node("p", `${row.location} · ${row.deployed_on} · ${MODE_TITLES[row.mode]}`));
      const actions = node("div", null, "actions");
      const edit = node("button", "Edit"); edit.type = "button";
      edit.setAttribute("aria-label", `Edit ${row.trap_id}`);
      edit.addEventListener("click", () => { fill(row); form.scrollIntoView({ behavior: "smooth", block: "start" }); });
      const remove = node("button", "Remove", "delete-label"); remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${row.trap_id}`);
      remove.addEventListener("click", () => {
        if (!window.confirm(`Remove ${row.trap_id} from this browser's label list? Printed labels are not changed.`)) return;
        saved = saved.filter((entry) => entry.trap_id !== row.trap_id);
        persistSaved(); renderSaved();
      });
      actions.append(edit, remove); item.append(info, actions); list.append(item);
    }
  }
  function refreshPrintArea() {
    const rows = printSource === "saved" ? saved : current ? [current] : [];
    printArea.replaceChildren(...rows.map(label));
  }
  function printRows(source) {
    render();
    if (source === "current" && !current) { form.reportValidity(); return; }
    if (source === "saved" && !saved.length) return;
    printSource = source;
    refreshPrintArea();
    window.print();
  }
  form.addEventListener("input", render);
  form.addEventListener("change", render);
  form.addEventListener("submit", (event) => { event.preventDefault(); printRows("current"); });
  saveButton.addEventListener("click", () => {
    render(); if (!current) return;
    const index = saved.findIndex((entry) => entry.trap_id === current.trap_id);
    if (index >= 0 && !window.confirm(`Replace the saved label details for ${current.trap_id}? Existing printed QR codes will not update.`)) return;
    const record = { ...current, saved_at: new Date().toISOString() };
    if (index >= 0) saved[index] = record; else saved.push(record);
    persistSaved(); renderSaved();
    if (storageAvailable) status.textContent = `Saved ${current.trap_id} in this browser. Export JSON to keep a separate copy.`;
  });
  document.getElementById("new-label").addEventListener("click", () => {
    fill({ deployed_on: localToday(), mode: "identity" });
    document.getElementById("trap-id").focus();
  });
  document.getElementById("print-saved").addEventListener("click", () => printRows("saved"));
  document.getElementById("export-labels").addEventListener("click", () => {
    const data = { schema: "vectordock-local-labels-v1", exported_at: new Date().toISOString(), records: saved };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
    const anchor = node("a"); anchor.href = url; anchor.download = `vectordock-labels-${localToday()}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener("beforeprint", refreshPrintArea);
  window.addEventListener("afterprint", () => { printSource = "current"; });
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    if (Array.isArray(raw)) {
      const ids = new Set();
      saved = raw.filter((row) => row && typeof row === "object" && !validate(row)).map(normalize).filter((row) => !ids.has(row.trap_id) && ids.add(row.trap_id));
    }
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    fill(draft && typeof draft === "object" ? normalize(draft) : { deployed_on: localToday(), mode: "identity" });
  } catch (_) {
    storageWarning("Browser storage could not be restored. This tab can still generate and print labels.");
    fill({ deployed_on: localToday(), mode: "identity" });
  }
  renderSaved();
}());
