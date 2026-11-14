// Dengue Defense — leaderboard API client, offline fallback and per-mode UI.
// ES module. Zero emojis. Shared by the static site (via <script type="module">)
// and verifiable in isolation under node --check.
//
// Exports: LB_API, submitScore, fetchTop, shareRun, openLeaderboard, closeLeaderboard

const PROD_API = 'https://dengue-api.datajoget.my.id';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);
const ALLOWED_MODES = new Set(['operations', 'crisis_board', 'blitz']);
const MODE_ORDER = ['operations', 'crisis_board', 'blitz'];
const MODE_LABELS = {
  operations: 'Operations',
  crisis_board: 'Crisis Board',
  blitz: 'Outbreak Blitz',
};
const PENDING_KEY = 'dd_lb_pending';
const NAME_KEY = 'dd_lb_name';
const OFFLINE_EN = 'Leaderboard offline — run saved locally';
const OFFLINE_ID = 'Papan skor luring — skor tersimpan lokal';
const OFFLINE_TEXT = `${OFFLINE_EN}\n${OFFLINE_ID}`;

function resolveLbApi() {
  let host = '';
  try {
    host = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
  } catch {
    host = '';
  }
  if (LOCAL_HOSTNAMES.has(host)) return ''; // same-origin: dev-server proxies /api/*
  if (host === 'dengue.datajoget.my.id') return PROD_API;
  if (host.endsWith('.workers.dev')) return PROD_API;
  return ''; // unknown/static hosts: same-origin, degrade gracefully to offline banner
}

export const LB_API = resolveLbApi();
try {
  if (typeof window !== 'undefined') window.LB_API = LB_API;
} catch {
  // Never break module import because of a locked-down window object.
}

function storageGet(key) {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function cachePendingSubmission(payload) {
  try {
    const raw = storageGet(PENDING_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    list.push({ ...payload, cachedAt: new Date().toISOString() });
    while (list.length > 20) list.shift();
    storageSet(PENDING_KEY, JSON.stringify(list));
  } catch {
    // Offline cache is best-effort; never throw.
  }
}

function showOfflineBanner() {
  if (typeof document === 'undefined') return;
  const status = document.getElementById('lbStatusMsg');
  if (status) {
    status.textContent = OFFLINE_TEXT;
    status.style.whiteSpace = 'pre-line';
    status.classList.remove('hidden');
    status.setAttribute('role', 'status');
    status.dataset.state = 'offline';
    return;
  }
  const host = document.getElementById('leaderboardScreen') || document.body;
  if (!host) return;
  let banner = host.querySelector('.lb-offline-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'lb-offline-banner';
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'margin-top:10px;white-space:pre-line;';
    host.appendChild(banner);
  }
  banner.textContent = OFFLINE_TEXT;
}

function normalizeMode(mode) {
  const m = String(mode ?? '').trim();
  return ALLOWED_MODES.has(m) ? m : 'operations';
}

function normalizeSubmission(run) {
  const r = run && typeof run === 'object' ? run : {};
  return {
    name: String(r.name ?? '').trim().slice(0, 24),
    score: Math.max(0, Math.floor(Number(r.score) || 0)),
    mode: normalizeMode(r.mode),
    doctrine: String(r.doctrine ?? '').trim().slice(0, 32),
    scenario: String(r.scenario ?? '').trim().slice(0, 32),
    seed: String(r.seed ?? r.seedStr ?? '').trim().slice(0, 40),
    mutators: Array.isArray(r.mutators)
      ? r.mutators.join(',').slice(0, 120)
      : String(r.mutators ?? '').trim().slice(0, 120),
    months: Math.min(6, Math.max(0, Math.floor(Number(r.months) || 0))),
  };
}

export async function fetchTop(mode = 'operations') {
  const m = normalizeMode(mode);
  try {
    const res = await fetch(`${LB_API}/api/top?mode=${encodeURIComponent(m)}&limit=20`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      showOfflineBanner();
      return null;
    }
    const data = await res.json().catch(() => null);
    if (!data) {
      showOfflineBanner();
      return null;
    }
    return data;
  } catch {
    showOfflineBanner();
    return null;
  }
}

export async function submitScore(run = {}) {
  const payload = normalizeSubmission(run);
  try {
    const res = await fetch(`${LB_API}/api/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      cachePendingSubmission(payload);
      showOfflineBanner();
      return null;
    }
    return data;
  } catch {
    cachePendingSubmission(payload);
    showOfflineBanner();
    return null;
  }
}

// ---------------------------------------------------------------------------
// Share card (canvas) with clipboard fallback. Never throws.
// ---------------------------------------------------------------------------

function gradeForScore(score) {
  if (score >= 500_000) return 'S';
  if (score >= 300_000) return 'A';
  if (score >= 150_000) return 'B';
  if (score >= 60_000) return 'C';
  return 'D';
}

function normalizeShareRun(run) {
  let source = run && typeof run === 'object' ? run : null;
  if (!source && typeof window !== 'undefined') {
    source = window.LB_LAST_RUN || window.G || null;
  }
  const s = source || {};
  const score = Math.max(0, Math.floor(Number(s.score) || 0));
  return {
    score,
    mode: normalizeMode(s.mode),
    grade: String(s.grade || gradeForScore(score)).slice(0, 2).toUpperCase(),
    seed: String(s.seed ?? s.seedStr ?? '').trim().slice(0, 40),
    doctrine: String(s.doctrine ?? '').trim().slice(0, 40),
    scenario: String(s.scenario ?? '').trim().slice(0, 40),
  };
}

function drawShareCard(ctx, w, h, data) {
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#0b2129');
  bg.addColorStop(1, '#123a44');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(94, 234, 212, 0.18)';
  ctx.lineWidth = 1;
  for (let x = 80; x < w; x += 80) {
    ctx.beginPath(); ctx.moveTo(x, 40); ctx.lineTo(x, h - 40); ctx.stroke();
  }
  for (let y = 80; y < h; y += 80) {
    ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(w - 40, y); ctx.stroke();
  }

  ctx.fillStyle = '#2dd4bf';
  ctx.fillRect(0, 0, w, 14);
  ctx.fillRect(0, h - 14, w, 14);

  ctx.fillStyle = '#7de3d2';
  ctx.font = '600 30px system-ui, "Segoe UI", sans-serif';
  ctx.fillText('DENGUE DEFENSE — FIELD EDITION', 80, 118);

  ctx.fillStyle = '#e6fffa';
  ctx.font = '700 44px system-ui, "Segoe UI", sans-serif';
  ctx.fillText(MODE_LABELS[data.mode] || MODE_LABELS.operations, 80, 185);

  ctx.fillStyle = '#f0fdfa';
  ctx.font = '800 170px system-ui, "Segoe UI", sans-serif';
  ctx.fillText(data.score.toLocaleString('en-US'), 72, 400);

  ctx.fillStyle = '#8ad6cc';
  ctx.font = '600 26px system-ui, "Segoe UI", sans-serif';
  const meta = [`Seed ${data.seed || 'n/a'}`];
  if (data.doctrine) meta.push(data.doctrine);
  if (data.scenario) meta.push(data.scenario);
  ctx.fillText(meta.join('  |  '), 80, 470);

  ctx.fillStyle = '#5eead4';
  ctx.font = '500 24px system-ui, "Segoe UI", sans-serif';
  ctx.fillText('dengue.datajoget.my.id', 80, h - 60);

  // Grade medallion
  const cx = w - 220;
  const cy = 300;
  ctx.beginPath();
  ctx.arc(cx, cy, 120, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(45, 212, 191, 0.12)';
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#2dd4bf';
  ctx.stroke();
  ctx.fillStyle = '#f0fdfa';
  ctx.font = '800 130px system-ui, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(data.grade, cx, cy + 8);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

function shareText(data) {
  return `Dengue Defense — ${MODE_LABELS[data.mode] || data.mode} | Score ${data.score.toLocaleString('en-US')} | Grade ${data.grade} | Seed ${data.seed || 'n/a'}`;
}

export function shareRun(run) {
  const data = normalizeShareRun(run);
  try {
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 630;
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (ctx) {
        drawShareCard(ctx, canvas.width, canvas.height, data);
        let href = null;
        try {
          href = canvas.toDataURL('image/png');
        } catch {
          href = null;
        }
        if (href) {
          const a = document.createElement('a');
          a.href = href;
          a.download = `dengue-defense-${data.mode}-${data.seed || 'run'}.png`;
          a.rel = 'noopener';
          if (document.body) document.body.appendChild(a);
          a.click();
          if (a.parentNode) a.parentNode.removeChild(a);
          return true;
        }
      }
    }
  } catch {
    // Fall through to clipboard fallback.
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(shareText(data)).catch(() => {});
      return true;
    }
  } catch {
    // Ignore and report failure below.
  }
  return false;
}

// ---------------------------------------------------------------------------
// Leaderboard UI (built lazily inside the existing #leaderboardScreen DOM)
// ---------------------------------------------------------------------------

const BADGE_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 1l6 2.2v4.1c0 3.6-2.4 6.4-6 7.7-3.6-1.3-6-4.1-6-7.7V3.2L8 1z"/></svg>';
let currentMode = 'operations';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function modeLabel(mode) {
  return MODE_LABELS[mode] || MODE_LABELS.operations;
}

function setStatus(statusEl, text) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.remove('hidden');
}

function setActiveTab(sheet, mode) {
  currentMode = mode;
  const tabs = sheet.querySelectorAll('#lbModeTabs .lb-mode-tab');
  tabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function ensureLeaderboardDom() {
  if (typeof document === 'undefined') return null;
  const screen = document.getElementById('leaderboardScreen');
  if (!screen) return null; // graceful no-op on pages without the screen
  const sheet = screen.querySelector('.sheet') || screen;

  let tabs = sheet.querySelector('#lbModeTabs');
  if (!tabs) {
    tabs = document.createElement('div');
    tabs.id = 'lbModeTabs';
    tabs.className = 'lb-mode-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Leaderboard mode');
    for (const m of MODE_ORDER) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lb-mode-tab';
      btn.dataset.mode = m;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      btn.textContent = modeLabel(m);
      tabs.appendChild(btn);
    }
    const rowsEl = sheet.querySelector('#lbRows');
    if (rowsEl) sheet.insertBefore(tabs, rowsEl);
    else sheet.appendChild(tabs);
  }

  let rows = sheet.querySelector('#lbRows');
  if (!rows) {
    rows = document.createElement('div');
    rows.id = 'lbRows';
    rows.className = 'lb-rows';
    sheet.appendChild(rows);
  }

  let input = sheet.querySelector('#lbNameInput');
  let submit = sheet.querySelector('#lbSubmitBtn');
  if (!input || !submit) {
    const wrap = document.createElement('div');
    wrap.className = 'lb-submit-row';
    wrap.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:10px;';
    input = document.createElement('input');
    input.id = 'lbNameInput';
    input.maxLength = 24;
    input.placeholder = 'Commander name';
    input.setAttribute('aria-label', 'Commander name');
    input.style.cssText = 'flex:1;min-width:0;';
    const savedName = storageGet(NAME_KEY);
    if (savedName) input.value = savedName;
    submit = document.createElement('button');
    submit.id = 'lbSubmitBtn';
    submit.type = 'button';
    submit.className = 'btn primary';
    submit.textContent = 'Submit';
    wrap.appendChild(input);
    wrap.appendChild(submit);
    if (rows.nextSibling) sheet.insertBefore(wrap, rows.nextSibling);
    else sheet.appendChild(wrap);
  }

  let status = sheet.querySelector('#lbStatusMsg');
  if (!status) {
    status = document.createElement('div');
    status.id = 'lbStatusMsg';
    status.setAttribute('role', 'status');
    status.style.cssText = 'margin-top:8px;min-height:1.2em;white-space:pre-line;';
    sheet.appendChild(status);
  }

  if (!screen.dataset.lbWired) {
    screen.dataset.lbWired = '1';
    tabs.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('.lb-mode-tab') : null;
      if (!btn || !btn.dataset.mode || !ALLOWED_MODES.has(btn.dataset.mode)) return;
      setActiveTab(sheet, btn.dataset.mode);
      setStatus(status, '');
      void loadAndRender(sheet, btn.dataset.mode);
    });
    submit.addEventListener('click', () => { void handleSubmit(sheet); });
    input.addEventListener('keydown', (ev) => {
      if (ev && ev.key === 'Enter') {
        ev.preventDefault();
        void handleSubmit(sheet);
      }
    });
  }

  return { screen, sheet, tabs, rows, input, submit, status };
}

function renderRows(rowsEl, data) {
  const entries = Array.isArray(data?.rows) ? data.rows : (Array.isArray(data?.entries) ? data.entries : []);
  if (!entries.length) {
    rowsEl.innerHTML = '<div class="lb-empty">No scores yet. Be the first commander on the board.</div>';
    return;
  }
  const html = entries.map((entry, i) => {
    const rank = i + 1;
    const name = escapeHtml(entry.name);
    const score = Number(entry.score || 0).toLocaleString('en-US');
    const badges = [];
    if (entry.doctrine) badges.push(`<span class="lb-badge">${BADGE_ICON}${escapeHtml(entry.doctrine)}</span>`);
    if (entry.scenario) badges.push(`<span class="lb-badge">${BADGE_ICON}${escapeHtml(entry.scenario)}</span>`);
    return `<div class="lb-row" data-rank="${rank}"><span class="lb-rank">#${rank}</span><span class="lb-name">${name}</span><span class="lb-score">${score}</span><span class="lb-badges">${badges.join('')}</span></div>`;
  }).join('');
  rowsEl.innerHTML = html;
}

async function loadAndRender(sheet, mode) {
  const rowsEl = sheet.querySelector('#lbRows');
  if (!rowsEl) return;
  rowsEl.innerHTML = '<div class="lb-empty">Loading…</div>';
  const data = await fetchTop(mode);
  if (!data) {
    rowsEl.innerHTML = `<div class="lb-empty">${escapeHtml(OFFLINE_EN)}<br>${escapeHtml(OFFLINE_ID)}</div>`;
    return;
  }
  renderRows(rowsEl, data);
}

async function handleSubmit(sheet) {
  const input = sheet.querySelector('#lbNameInput');
  const status = sheet.querySelector('#lbStatusMsg');
  const name = String(input?.value ?? '').trim();
  if (!name) {
    setStatus(status, 'Enter a commander name.');
    return;
  }
  const g = typeof window !== 'undefined' ? window.G : null;
  const pending = Number(
    (typeof window !== 'undefined' && window.LB_PENDING_SCORE != null ? window.LB_PENDING_SCORE : g && g.score) || 0
  );
  if (!Number.isFinite(pending) || pending < 1) {
    setStatus(status, 'No completed run to submit yet.');
    return;
  }
  const mode = g && ALLOWED_MODES.has(g.mode) ? g.mode : currentMode;
  storageSet(NAME_KEY, name);
  setStatus(status, 'Submitting…');
  const result = await submitScore({
    name,
    score: pending,
    mode,
    doctrine: g?.doctrine,
    scenario: g?.scenario,
    seed: g?.seedStr ?? g?.seed,
    mutators: g?.mutators,
    months: g?.months,
  });
  if (result && result.ok === true) {
    const resultMode = normalizeMode(result.mode || mode);
    setStatus(status, `Submitted. Rank #${result.rank} in ${modeLabel(resultMode)}.`);
    setActiveTab(sheet, resultMode);
    await loadAndRender(sheet, resultMode);
  }
  // Failure path: submitScore already cached dd_lb_pending and showed the offline banner.
}

export function openLeaderboard(defaultMode = 'operations') {
  const dom = ensureLeaderboardDom();
  if (!dom) return false;
  // Competing overlays would cover the board (same z-index, later in DOM); dismiss them.
  for (const sel of ['#endScreen', '#pauseScreen', '#perkScreen', '#reportScreen', '#dispatchScreen', '#badgeScreen']) {
    const el = typeof document !== 'undefined' ? document.querySelector(sel) : null;
    if (el) { el.classList.add('hidden'); el.setAttribute('hidden', ''); }
  }
  const m = normalizeMode(defaultMode);
  dom.screen.classList.remove('hidden');
  dom.screen.removeAttribute('hidden');
  setActiveTab(dom.sheet, m);
  setStatus(dom.status, '');
  void loadAndRender(dom.sheet, m);
  return true;
}

export function closeLeaderboard() {
  if (typeof document === 'undefined') return false;
  const screen = document.getElementById('leaderboardScreen');
  if (!screen) return false;
  screen.classList.add('hidden');
  return true;
}
