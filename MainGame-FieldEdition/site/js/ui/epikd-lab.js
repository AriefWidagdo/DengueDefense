/* Dengue Defense - Field Edition: Optional "EpiKD Lab & Field Manual" drawer.

   This module is the ONLY place where NB2 distribution math, MODEL_DATA
   checkpoint provenance and the additive wave waterfall render. Active
   gameplay HUD/report screens stay diegetic; this drawer is opt-in and is
   never forced and never badge-pinged. During active waves and Blitz it
   stays badge-quiet: it opens only via the #epikdLabDrawer pill toggle, the
   'dd:open-epikd' / 'dd:open-epikd-audit' events (dispatched by report /
   EpiKD buttons), or the exported open functions. No toast, counter or
   badge is ever emitted from here.

   Exports: openEpikdLab, closeEpikdLab, openWaveAttributionAudit.

   Styling comes from css/layout.css (#epikdLabDrawer, .epikd-scrim) and
   css/components.css (.drawer-head/.drawer-tabs/.drawer-tab/.drawer-body/
   .ledger/.ledger-row/.driver-bar ...). No <style> blocks are injected.
   All copy flows through t() (i18n.js, epikd.* family) with inline EN
   fallbacks when a key is missing. Zero emojis; icons are inline SVG. */

import { MODEL_DATA } from '../epi-data.js';
import { DISTRICT_DEFS, EpiRuntime, computeDistrictDrivers } from '../epi-engine.js';
import { getG, getW, GAME_RULES, MONTHS, DOCTRINES } from '../state.js';
import { t, getLang } from '../i18n.js';

/* ---------------------------------------------------------------------
   Small utilities
   --------------------------------------------------------------------- */
const clampNum = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const fmtSigned = (n) => (n >= 0 ? '+' : '') + fmtInt(n);
const fmtPct = (n, digits = 0) => (n >= 0 ? '+' : '') + (Number(n) || 0).toFixed(digits) + '%';
const lastFinite = (arr) => {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return null;
};
const pctChange = (cur, ref) => ((Number(cur) - Number(ref)) / Math.max(1, Math.abs(Number(ref) || 0))) * 100;

/* t() with inline EN fallback: when the key is missing in both packs, t()
   returns the raw key; detect that and substitute the fallback copy. */
const tr = (key, fallback, vars) => {
  const v = t(key, vars);
  return v === key ? fallback : v;
};
const isId = () => getLang() === 'id';
const pick = (obj) => {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj[getLang()] || obj.en || '';
};

const TABS = Object.freeze(['model', 'drivers', 'audit', 'manual']);
const TAB_LABEL_KEYS = Object.freeze({ model: 'epikd.tab.model', drivers: 'epikd.tab.drivers', audit: 'epikd.tab.audit', manual: 'epikd.tab.manual' });
const TAB_LABEL_FALLBACK = Object.freeze({ model: 'Model Card', drivers: 'District Drivers', audit: 'Waterfall Audit', manual: 'Field Manual' });

/* Module-scoped UI state (drawer is a singleton). */
let drawerEl = null;
let scrimEl = null;
let activeTab = 'model';
let driversDistrictId = null;   // Tab 2 selection
let auditFilter = null;         // Tab 3 district filter (from openWaveAttributionAudit / event)
let lastEventReport = null;     // report payload captured from 'dd:open-epikd-audit'
let lastFocus = null;

const defaultDistrictId = () => {
  const G = getG();
  return (G && (G.selectedDistrict || G.selected)) || 'klaten';
};
const activeDriversId = () => driversDistrictId || defaultDistrictId();

/* ---------------------------------------------------------------------
   Inline SVG icon set (zero emojis). Stroke-based, currentColor.
   --------------------------------------------------------------------- */
const svgOpen = (size, vb) => `<svg width="${size}" height="${size}" viewBox="${vb || '0 0 24 24'}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">`;
const ICON = {
  flask: `${svgOpen(16)}<path d="M9.5 3h5M10 3v6.2L5.6 15.6A2.2 2.2 0 0 0 7.6 18.4h8.8a2.2 2.2 0 0 0 2-2.8L14 9.2V3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.2 13h7.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  close: `${svgOpen(15)}<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  mosquito: (color, size, variant) => {
    const s = size || 34;
    const aura = variant === 'viremic'
      ? `<circle cx="12" cy="12" r="10.6" fill="${color}" opacity="0.16"/><circle cx="12" cy="12" r="7.4" fill="${color}" opacity="0.18"/>` : '';
    const crown = variant === 'queen'
      ? `<path d="M9.6 4.6l1.2-1.6 1.2 1.4 1.2-1.6 1.2 1.8" stroke="${color}" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` : '';
    const weave = variant === 'flanker'
      ? `<path d="M2.5 12c2-2.6 4-2.6 6 0M15.5 12c2-2.6 4-2.6 6 0" stroke="${color}" stroke-width="1.25" stroke-linecap="round" fill="none" opacity="0.85"/>` : '';
    const wing = variant === 'queen' ? 1.35 : 1;
    return `${svgOpen(s, '0 0 24 24')}${aura}${crown}${weave}
<ellipse cx="12" cy="13.4" rx="2.5" ry="4.4" fill="${color}" opacity="0.92"/>
<circle cx="12" cy="7.3" r="1.55" fill="${color}"/>
<ellipse cx="7.6" cy="11.2" rx="${4.1 * wing}" ry="1.9" fill="${color}" opacity="0.38" transform="rotate(-24 7.6 11.2)"/>
<ellipse cx="16.4" cy="11.2" rx="${4.1 * wing}" ry="1.9" fill="${color}" opacity="0.38" transform="rotate(24 16.4 11.2)"/>
<path d="M10.2 16.4l-2.4 3.4M13.8 16.4l2.4 3.4M9.3 13.6H5.6M14.7 13.6h3.7" stroke="${color}" stroke-width="1.15" stroke-linecap="round"/>
<path d="M12 5.8L12 2.6" stroke="${color}" stroke-width="1.15" stroke-linecap="round"/>
</svg>`;
  },
  drip: `${svgOpen(13)}<path d="M7 2.5C7 2.5 3.6 7 3.6 9.6a3.4 3.4 0 0 0 6.8 0C10.4 7 7 2.5 7 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/></svg>`,
  trap: `${svgOpen(13)}<path d="M3 9h8l-1.2 6H4.2L3 9Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/><path d="M5 9V6.5A1.5 1.5 0 0 1 6.5 5h1A1.5 1.5 0 0 1 9 6.5V9" stroke="currentColor" stroke-width="1.3"/></svg>`,
  fog: `${svgOpen(13)}<path d="M2.5 8h6.5M4 11h5.5M2.5 14h6.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12 5.5l6 3.5-6 3.5v-7Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/></svg>`,
  clinic: `${svgOpen(13)}<path d="M2.5 11.5L7 7.5l4.5 4M4.5 10v4.5h5V10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M10.5 3.5h3v3h3v3h-3v3h-3v-3h-3v-3h3v-3Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" fill="none"/></svg>`,
  shield: `${svgOpen(13)}<path d="M7 2.5l4 1.6 4-1.6 1.2 5.2c0 3.4-2.1 5.6-5.2 6.8-3.1-1.2-5.2-3.4-5.2-6.8L7 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/></svg>`,
};

/* Shared inline-style fragments (no <style> injection allowed). */
const TRACK_STYLE = 'display:block;height:8px;border-radius:var(--radius-pill);background:var(--bg-body);border:1px solid var(--border-subtle);overflow:hidden;';
const fillStyle = (pct, color) => `display:block;height:100%;width:${clampNum(pct, 0, 100).toFixed(1)}%;background:${color};border-radius:var(--radius-pill);`;
const CALLOUT_STYLE = 'border:1px solid var(--border-subtle);border-left:3px solid var(--accent-bio);background:var(--bg-elevated);border-radius:var(--radius-md);padding:10px 12px;font-size:0.72rem;line-height:1.55;color:var(--text-secondary);';
const WARN_CALLOUT_STYLE = 'border:1px solid var(--border-subtle);border-left:3px solid var(--status-warn);background:var(--bg-elevated);border-radius:var(--radius-md);padding:10px 12px;font-size:0.72rem;line-height:1.55;color:var(--text-secondary);';
const NOTE_STYLE = 'font-size:0.62rem;color:var(--text-muted);line-height:1.5;';
const DL_STYLE = 'display:grid;grid-template-columns:minmax(104px,auto) 1fr;gap:5px 12px;margin:0;font-size:0.72rem;';
const DT_STYLE = 'color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-size:0.58rem;align-self:center;';
const DD_STYLE = 'margin:0;color:var(--text-primary);font-family:var(--font-mono);font-variant-numeric:tabular-nums;word-break:break-word;';
const CHIP_STYLE = 'display:inline-block;padding:2px 8px;border-radius:var(--radius-pill);border:1px solid var(--border-strong);font-size:0.55rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent-hydro);';
const WARN_CHIP_STYLE = CHIP_STYLE.replace('var(--accent-hydro)', 'var(--status-warn)');
const SECTION_LABEL_STYLE = 'font-size:0.58rem;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-muted);margin:2px 0 0;';
const SELECT_STYLE = 'background:var(--bg-body);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:var(--radius-md);padding:5px 8px;font-size:0.7rem;font-family:var(--font-sans);';
const MINI_BTN_STYLE = 'background:transparent;border:1px solid var(--border-strong);color:var(--text-secondary);border-radius:var(--radius-md);padding:4px 10px;font-size:0.62rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;cursor:pointer;';

const barRow = ({ label, desc, valText, pct, tone, mono }) => {
  const color = tone === 'safe' ? 'var(--status-safe)' : tone === 'hydro' ? 'var(--accent-hydro)' : 'var(--status-danger)';
  return `<div class="driver-bar" title="${esc(desc || '')}">
    <span class="driver-bar-label">${esc(label)}</span>
    <span style="${TRACK_STYLE}"><span style="${fillStyle(pct, color)}"></span></span>
    <span class="driver-bar-value"${mono ? ' style="font-family:var(--font-mono);"' : ''}>${esc(valText)}</span>
  </div>`;
};

/* ---------------------------------------------------------------------
   District resolution: live campaign state first, deterministic MODEL_DATA
   preview otherwise (drawer must work before any campaign starts).
   --------------------------------------------------------------------- */
function previewDistrict(id) {
  const def = DISTRICT_DEFS.find(d => d.id === id) || DISTRICT_DEFS[0];
  const src = (MODEL_DATA.districts && MODEL_DATA.districts[def.id]) || {};
  const snap = MODEL_DATA.snapshots[0];
  const di = clampNum(snap.issue - MODEL_DATA.history0, 0, (src.cases || []).length - 1);
  const lastRain = lastFinite(src.rain) || 180;
  const pools = Math.round(clampNum(5 + lastRain / 60, 4, 14));
  const nb = Object.keys(src.weights || {}).filter(k => src.weights[k] > 0);
  return {
    id: def.id,
    name: def.name,
    pop: (Number(src.population && src.population[di]) / 1e6 || 1).toFixed(2) + 'M',
    pools,
    referencePools: pools,
    cases: Number(src.cases && src.cases[di]) || 0,
    nb,
    proto: { psn: false, traps: false, fog: false, clinic: false },
    revealedShockMult: 1,
    revealedDelayedCases: 0,
    trueShockMult: 1,
    trueDelayedCases: 0,
    epi: null,
    outlook: null,
    _preview: true,
  };
}

function resolveDistricts() {
  const G = getG();
  if (G && Array.isArray(G.districts) && G.districts.length) return G.districts;
  return DISTRICT_DEFS.map(d => previewDistrict(d.id));
}

function resolveDistrict(id) {
  const list = resolveDistricts();
  const want = id || activeDriversId();
  return list.find(d => d && d.id === want) || list[0] || previewDistrict('klaten');
}

function districtMap() {
  const map = {};
  for (const d of resolveDistricts()) if (d && d.id) map[d.id] = d;
  return map;
}

function districtOptions(selectedId) {
  return DISTRICT_DEFS.map(d =>
    `<option value="${esc(d.id)}"${d.id === selectedId ? ' selected' : ''}>${esc(d.name)}</option>`
  ).join('');
}

/* ---------------------------------------------------------------------
   TAB 1 — Model Card
   --------------------------------------------------------------------- */
function renderModelTab() {
  const meta = MODEL_DATA.meta || {};
  const info = meta.info || {};
  const limitations = Array.isArray(meta.limitations) ? meta.limitations : [];
  const params = fmtInt(info.params || 0);
  const wis = Number(info.best_val_scaled_wis);
  const trainSecs = Number(info.train_seconds);

  // Live NB2 readout (only when a campaign is running and epi exists).
  const G = getG();
  const d = resolveDistrict(activeDriversId());
  const epi = d && d.epi ? d.epi : null;
  let liveBlock = '';
  if (epi && Number.isFinite(epi.mu) && Number.isFinite(epi.kappa)) {
    let q25 = null, q50 = null, q75 = null, p90 = null;
    try {
      q25 = EpiRuntime.nbQuantile(0.25, epi.mu, epi.kappa);
      q50 = EpiRuntime.nbQuantile(0.50, epi.mu, epi.kappa);
      q75 = EpiRuntime.nbQuantile(0.75, epi.mu, epi.kappa);
      p90 = EpiRuntime.nbQuantile(0.90, epi.mu, epi.kappa);
    } catch (e) { /* quantiles are best-effort */ }
    const alpha = epi.kappa > 0 ? 1 / epi.kappa : null;
    const exceed = Number.isFinite(epi.eventProb) ? (epi.eventProb * 100).toFixed(1) + '%' : 'n/a';
    const threshold = Number.isFinite(epi.threshold) ? fmtInt(epi.threshold) : 'n/a';
    liveBlock = `
      <div>
        <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.model.live', 'Live NB2 readout'))} — ${esc(d.name || d.id)}</div>
        <dl style="${DL_STYLE};margin-top:8px;">
          <dt style="${DT_STYLE}">mu (mean)</dt><dd style="${DD_STYLE}">${epi.mu.toFixed(2)} cases / month</dd>
          <dt style="${DT_STYLE}">alpha (1/kappa)</dt><dd style="${DD_STYLE}">${alpha != null ? alpha.toFixed(4) : 'n/a'} <span style="color:var(--text-muted)">(kappa = ${epi.kappa.toFixed(3)})</span></dd>
          <dt style="${DT_STYLE}">Q25 / median / Q75</dt><dd style="${DD_STYLE}">${q25 != null ? `${fmtInt(q25)} / ${fmtInt(q50)} / ${fmtInt(q75)}` : 'n/a'}</dd>
          <dt style="${DT_STYLE}">IQR (Q25-Q75)</dt><dd style="${DD_STYLE}">${q25 != null ? `${fmtInt(q25)} - ${fmtInt(q75)}  (width ${fmtInt(q75 - q25)})` : 'n/a'}</dd>
          <dt style="${DT_STYLE}">P90 upper tail</dt><dd style="${DD_STYLE}">${p90 != null ? fmtInt(p90) : (Number.isFinite(epi.high80) ? fmtInt(epi.high80) : 'n/a')} cases</dd>
          <dt style="${DT_STYLE}">Exceedance &gt; endemic threshold</dt><dd style="${DD_STYLE}">${exceed} <span style="color:var(--text-muted)">(threshold ${threshold})</span></dd>
        </dl>
      </div>`;
  } else {
    liveBlock = `<div style="${NOTE_STYLE}">${esc(tr('epikd.model.liveEmpty', 'Live NB2 readout appears here once a campaign is running (the selected district carries mu, kappa, quantiles and exceedance).'))}</div>`;
  }

  return `
    <h3>${esc(tr('epikd.model.cardTitle', 'Checkpoint Model Card'))}</h3>
    <dl style="${DL_STYLE}">
      <dt style="${DT_STYLE}">${esc(tr('epikd.model.engine', 'Engine'))}</dt>
      <dd style="${DD_STYLE}">${esc(meta.name || 'EpiKD KDA')}</dd>
      <dt style="${DT_STYLE}">${esc(tr('epikd.model.checkpoint', 'Checkpoint'))}</dt>
      <dd style="${DD_STYLE}">${esc(meta.checkpoint || 'model_kda_17.pt')}</dd>
      <dt style="${DT_STYLE}">${esc(tr('epikd.model.backbone', 'Backbone'))}</dt>
      <dd style="${DD_STYLE}">${esc(info.backbone || 'kda')}</dd>
      <dt style="${DT_STYLE}">${esc(tr('epikd.model.params', 'Parameters'))}</dt>
      <dd style="${DD_STYLE}">${esc(params)}</dd>
      <dt style="${DT_STYLE}">${esc(tr('epikd.model.seed', 'Seed'))}</dt>
      <dd style="${DD_STYLE}">${esc(String(info.seed ?? 17))}</dd>
      <dt style="${DT_STYLE}">${esc(tr('epikd.model.lookback', 'Lookback'))}</dt>
      <dd style="${DD_STYLE}">${esc(tr('epikd.model.lookbackValue', '24 months'))} <span style="color:var(--text-muted)">(${esc(String(meta.lookback || 24))} steps)</span></dd>
      <dt style="${DT_STYLE}">${esc(tr('epikd.model.arch', 'Architecture'))}</dt>
      <dd style="${DD_STYLE}">${esc(String(meta.layers ?? 1))} layer x ${esc(String(meta.width ?? 64))} width x ${esc(String(meta.heads ?? 2))} heads, ${esc(String(meta.horizons ?? 3))} horizons</dd>
      <dt style="${DT_STYLE}">${esc(tr('epikd.model.wis', 'Best val scaled WIS'))}</dt>
      <dd style="${DD_STYLE}">${Number.isFinite(wis) ? wis.toFixed(6) : 'n/a'} <span style="color:var(--text-muted)">(${esc(String(info.epochs_ran ?? 'n/a'))} epochs, ${Number.isFinite(trainSecs) ? trainSecs.toFixed(1) + 's train' : 'n/a'})</span></dd>
      <dt style="${DT_STYLE}">${esc(tr('epikd.model.sourceMode', 'Source mode'))}</dt>
      <dd style="${DD_STYLE}">${esc(meta.sourceMode || 'n/a')} <span style="color:var(--text-muted)">(fit end ${esc(String(meta.fitEnd ?? 'n/a'))})</span></dd>
      <dt style="${DT_STYLE}">${esc(tr('epikd.model.checkpointSha', 'Checkpoint SHA-256'))}</dt>
      <dd style="${DD_STYLE};font-size:0.62rem;">${esc(meta.checkpointSha256 || 'n/a')}</dd>
      <dt style="${DT_STYLE}">${esc(tr('epikd.model.run', 'Training run'))}</dt>
      <dd style="${DD_STYLE};font-size:0.62rem;">${esc(meta.run || 'n/a')}</dd>
    </dl>

    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.model.output', 'Statistical Output'))}</div>
      <ul style="margin:8px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px;">
        <li>${esc(tr('epikd.model.nb2', 'Negative Binomial (NB2) predictive distribution. Emits mean (mu) and dispersion (alpha) per district per month.'))}</li>
        <li>${esc(tr('epikd.model.iqr', 'IQR band (Q25-Q75) rendered as the uncertainty range on every projection.'))}</li>
        <li>${esc(tr('epikd.model.p90', 'P90 upper tail marks the severe-case ceiling for surge planning.'))}</li>
        <li>${esc(tr('epikd.model.exceedance', 'Exceedance probability over the endemic threshold drives threat tiers.'))}</li>
      </ul>
    </div>

    ${liveBlock}

    <div style="${CALLOUT_STYLE}">
      <strong style="color:var(--accent-bio);letter-spacing:0.08em;text-transform:uppercase;font-size:0.6rem;">${esc(tr('epikd.model.noteTitle', 'Research note'))}</strong><br>
      ${esc(tr('epikd.model.note', 'Forecasts are statistical model outputs conditioned on historical surveillance and climate covariates. GAME_RULES prevention factors (PSN, Ovitrap, Fog, Clinic) are calibrated tactical game mechanics, distinct from model behavior.'))}
    </div>

    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.scope.title', 'Model Scope & Assumptions'))}</div>
      <p style="margin:8px 0 0;">${esc(tr('epikd.scope.body', 'EpiKD KDA is a retrospective research prototype trained on Central Java and DIY surveillance across NOV-APR seasons. Forecasts are statistical model outputs, not guarantees. Prevention and policy effects are tactical game rules, not model physics. Upgrades change game rules, not model behavior. Waterfall ledgers decompose simulated outcomes additively for transparency.'))}</p>
      ${limitations.length ? `<ul style="margin:8px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px;">${limitations.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    </div>`;
}

/* ---------------------------------------------------------------------
   TAB 2 — District Drivers
   --------------------------------------------------------------------- */
function modelSignalRows(d) {
  const turn = (() => { const G = getG(); return G && Number.isInteger(G.turn) ? G.turn : 0; })();
  const snap = MODEL_DATA.snapshots[clampNum(turn, 0, MODEL_DATA.snapshots.length - 1)];
  const src = (MODEL_DATA.districts && MODEL_DATA.districts[d.id]) || {};
  const cases = Array.isArray(src.cases) ? src.cases : [];
  const di = clampNum(snap.issue - MODEL_DATA.history0, 1, Math.max(1, cases.length - 1));
  const rows = [];

  const lag1 = pctChange(cases[di], cases[di - 1]);
  rows.push({
    label: tr('epikd.drivers.lag1', 'Prior-month case momentum (lag1)'),
    desc: `log-scale case signal, ordinal ${snap.issue - 1} to ${snap.issue}`,
    val: lag1, valText: fmtPct(lag1, 0),
  });

  const trend3 = pctChange(cases[di], cases[Math.max(0, di - 2)]);
  rows.push({
    label: tr('epikd.drivers.trend', '3-month trend'),
    desc: 'Net case movement across the trailing 3 observed months',
    val: trend3, valText: fmtPct(trend3, 0),
  });

  const future = Array.isArray(snap.future) ? snap.future[0] : null;
  if (future && Number.isFinite(future[0]) && Number.isFinite(future[1])) {
    const rad = Math.atan2(future[1], future[0]);
    const angle = (rad * 180 / Math.PI + 360) % 360;
    rows.push({
      label: tr('epikd.drivers.seasonal', 'Seasonal harmonic angle (NOV-APR)'),
      desc: 'Phase of the model seasonal harmonic covariate for the lead horizon (monsoon arc NOV-APR)',
      val: Math.sin(rad) * 45, valText: angle.toFixed(0) + ' deg', tone: 'hydro',
    });
  }
  return rows;
}

function renderDriversTab() {
  const d = resolveDistrict(activeDriversId());
  const G = getG();
  const isLive = !!(G && Array.isArray(G.districts) && G.districts.includes(d));
  const lang = getLang();
  const turn = G && Number.isInteger(G.turn) ? G.turn : 0;
  let drivers = [];
  try {
    drivers = computeDistrictDrivers(d, {
      turn,
      months: MONTHS,
      districts: districtMap(),
      lang,
      prevention: G && Number.isFinite(G.prevention) ? G.prevention : 0,
      climateProfile: (G && G.climateProfile) || 'baseline',
    }) || [];
  } catch (e) { drivers = []; }

  const signalRows = modelSignalRows(d);
  const rainRow = drivers.find(x => x.icon === 'rain');
  const transitRow = drivers.find(x => x.icon === 'transit');

  // Feature block: MODEL_DATA-derived signals + rainfall + spillover.
  const featureBlocks = [];
  for (const r of signalRows) {
    featureBlocks.push(barRow({
      label: r.label, desc: r.desc, valText: r.valText,
      pct: Math.abs(r.val) / 45 * 100,
      tone: r.tone || (r.val >= 0 ? 'danger' : 'safe'),
    }));
  }
  featureBlocks.push(barRow({
    label: tr('epikd.drivers.rainfall', 'Rainfall / climate index'),
    desc: rainRow ? rainRow.desc : 'Prior-month rainfall vs district climatology',
    valText: rainRow ? rainRow.valText : '0%',
    pct: rainRow ? Math.abs(rainRow.val) / 45 * 100 : 0,
    tone: rainRow ? (rainRow.val >= 0 ? 'danger' : 'safe') : 'hydro',
  }));
  featureBlocks.push(barRow({
    label: tr('epikd.drivers.spillover', 'Inter-district spillover pressure (nb neighbors)'),
    desc: transitRow ? transitRow.desc : 'No material spillover signal from neighboring districts',
    valText: transitRow ? transitRow.valText : '0%',
    pct: transitRow ? Math.abs(transitRow.val) / 45 * 100 : 0,
    tone: transitRow ? (transitRow.val >= 0 ? 'danger' : 'safe') : 'hydro',
  }));

  // Feed block: remaining computeDistrictDrivers rows (pools, season, density,
  // protocols, shocks) - everything not already surfaced above.
  const surfaced = new Set(['rain', 'transit']);
  const feedRows = drivers.filter(x => !surfaced.has(x.icon));
  const feedHtml = feedRows.length
    ? feedRows.map(x => barRow({
        label: x.name,
        desc: x.desc,
        valText: x.valText,
        pct: Math.abs(Number(x.val) || 0) / 45 * 100,
        tone: (Number(x.val) || 0) >= 0 ? 'danger' : 'safe',
      })).join('')
    : `<div style="${NOTE_STYLE}">${esc(tr('epikd.drivers.noFeed', 'No additional pressure or mitigation signals for this district right now.'))}</div>`;

  // Positive pressure vs active mitigation balance.
  let posSum = 0, mitSum = 0;
  for (const x of drivers) {
    const v = Number(x.val) || 0;
    if (v >= 0) posSum += v; else mitSum += -v;
  }
  const total = posSum + mitSum;
  const posW = total > 0 ? (posSum / total) * 100 : 50;
  const mitW = total > 0 ? (mitSum / total) * 100 : 50;
  const balanceHtml = total > 0
    ? `<div style="display:flex;height:14px;border-radius:var(--radius-pill);overflow:hidden;border:1px solid var(--border-subtle);">
         <div style="width:${posW.toFixed(1)}%;background:var(--status-danger);" title="${esc(tr('epikd.drivers.positive', 'Positive pressure'))}: +${posSum.toFixed(0)}%"></div>
         <div style="width:${mitW.toFixed(1)}%;background:var(--status-safe);" title="${esc(tr('epikd.drivers.mitigation', 'Active mitigation'))}: -${mitSum.toFixed(0)}%"></div>
       </div>
       <div style="display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-size:0.62rem;">
         <span style="color:var(--status-danger);font-family:var(--font-mono);">${esc(tr('epikd.drivers.positive', 'Positive pressure'))} +${posSum.toFixed(0)}%</span>
         <span style="color:var(--status-safe);font-family:var(--font-mono);">${esc(tr('epikd.drivers.mitigation', 'Active mitigation'))} -${mitSum.toFixed(0)}%</span>
       </div>`
    : `<div style="${NOTE_STYLE}">${esc(tr('epikd.drivers.balanceEmpty', 'No active pressure or mitigation signals to balance yet.'))}</div>`;

  // Per-driver detail list with badges.
  const detailHtml = drivers.length
    ? drivers.map(x => `<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;border-bottom:1px solid var(--border-subtle);padding:4px 0;">
         <span style="color:var(--text-secondary);">${esc(x.name)} <span style="color:var(--text-muted);font-size:0.58rem;text-transform:uppercase;letter-spacing:0.08em;">[${esc(x.badge || '')}]</span></span>
         <span style="font-family:var(--font-mono);color:${(Number(x.val) || 0) >= 0 ? 'var(--status-danger)' : 'var(--status-safe)'};">${esc(x.valText)}</span>
       </div>`).join('')
    : `<div style="${NOTE_STYLE}">${esc(tr('epikd.drivers.empty', 'Select a district to inspect its drivers.'))}</div>`;

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <h3 style="margin:0;">${esc(tr('epikd.drivers.title', 'Live District Drivers'))}</h3>
      <label style="display:flex;align-items:center;gap:8px;font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;">
        <span style="${isLive ? CHIP_STYLE : WARN_CHIP_STYLE}">${isLive ? esc(tr('epikd.live', 'Live')) : esc(tr('epikd.preview', 'Preview'))}</span>
        <select id="epikdDriverSelect" data-epikd-drivers-select style="${SELECT_STYLE}" aria-label="${esc(tr('epikd.drivers.select', 'Select district'))}">
          ${districtOptions(d.id)}
        </select>
      </label>
    </div>

    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.drivers.signals', 'Model feature signals'))}</div>
      <div style="margin-top:6px;">${featureBlocks.join('')}</div>
    </div>

    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.drivers.feed', 'Driver feed (pressure vs mitigation)'))}</div>
      <div style="margin-top:6px;">${feedHtml}</div>
    </div>

    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.drivers.balance', 'Positive pressure vs active mitigation'))}</div>
      <div style="margin-top:8px;">${balanceHtml}</div>
    </div>

    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.drivers.detail', 'Driver detail'))}</div>
      <div style="margin-top:6px;">${detailHtml}</div>
    </div>

    <div style="${NOTE_STYLE}">${esc(tr('epikd.drivers.footnote', 'Indicative weights from the epi feature engine and active protocol state; not causal attribution. Values recompute on selection.'))}</div>`;
}

/* ---------------------------------------------------------------------
   TAB 3 — Waterfall Audit (additive decomposition ledger)
   Rows always close exactly: baseline + shock = gross; gross - prevention =
   effective; effective - interception = actual.
   --------------------------------------------------------------------- */
function normalizeAuditDistrict(raw, fallbackName) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const baseline = num(raw.baseline) ?? num(raw.baselineCases) ?? num(raw.modelMean) ?? 0;
  const shock = num(raw.shockDelta) ?? num(raw.climateDelta) ?? num(raw.shock) ?? num(raw.delta) ?? 0;
  const gross = baseline + shock;
  const actualGiven = num(raw.cases) ?? num(raw.actual) ?? num(raw.actualCases) ?? num(raw.final);
  const preventionGiven = num(raw.prevention) ?? num(raw.protocolPrevention) ?? num(raw.preventionPrevented);
  const interceptionGiven = num(raw.interception) ?? num(raw.fieldInterception) ?? num(raw.intercepted);
  const prevented = Math.max(0, gross - (actualGiven != null ? actualGiven : gross));
  let prevention; let interception; let splitEstimated = false;
  if (preventionGiven != null && interceptionGiven != null) {
    prevention = preventionGiven; interception = interceptionGiven;
  } else if (preventionGiven != null) {
    prevention = preventionGiven; interception = Math.max(0, gross - prevention - (actualGiven != null ? actualGiven : 0));
  } else if (interceptionGiven != null) {
    interception = interceptionGiven; prevention = Math.max(0, gross - interception - (actualGiven != null ? actualGiven : 0));
  } else {
    prevention = Math.round(prevented * 0.6);
    interception = prevented - prevention;
    splitEstimated = prevented > 0;
  }
  const effective = gross - prevention;
  const actual = actualGiven != null ? actualGiven : effective - interception;
  interception = effective - actual; // force exact additive closure
  return {
    id: raw.id || raw.districtId || null,
    name: raw.name || fallbackName || (raw.id || 'UNKNOWN'),
    baseline: Math.round(baseline),
    shock: Math.round(shock),
    gross: Math.round(gross),
    prevention: Math.round(prevention),
    effective: Math.round(effective),
    interception: Math.round(interception),
    actual: Math.round(actual),
    splitEstimated,
  };
}

function normalizeLiveAudit(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.districts) ? raw.districts : null);
  const districts = (list || []).map(r => normalizeAuditDistrict(r || {}, r && r.name));
  return {
    source: raw && raw.source ? raw.source : 'live',
    label: (raw && (raw.label || raw.monthLabel)) || null,
    turn: raw && Number.isInteger(raw.turn) ? raw.turn : null,
    districts,
    notes: raw && Array.isArray(raw.notes) ? raw.notes.slice() : [],
  };
}

function synthesizeIllustrativeDistrict(d) {
  const mu = d.epi && Number.isFinite(d.epi.mu) ? d.epi.mu : (Number(d.cases) || 20);
  const baseline = Math.max(1, Math.round(mu));
  const shockMult = Number(d.trueShockMult || d.revealedShockMult) || 1;
  let shock = Math.round(baseline * (shockMult - 1)) + Math.round(Number(d.trueDelayedCases || d.revealedDelayedCases) || 0);
  const notes = [];
  if (shock === 0) {
    shock = Math.round(baseline * 0.15);
    notes.push('Illustrative: +15% monsoon climate/shock delta assumed (no live shock on record).');
  }
  const gross = baseline + shock;

  let factor = 1;
  if (d.proto && d.proto.psn) factor *= GAME_RULES.psnFactor;
  if (d.proto && d.proto.traps) factor *= 0.85;
  if (d.proto && d.proto.fog) factor *= 0.80;
  let prevention;
  if (factor < 1) {
    prevention = Math.round(gross * (1 - factor));
  } else {
    prevention = Math.round(gross * (1 - GAME_RULES.psnFactor * 0.85));
    notes.push('Illustrative: PSN x Ovitrap stack assumed (no protocol currently deployed).');
  }
  const effective = gross - prevention;

  const W = getW();
  const stats = W && W.byDistrict && d.id ? W.byDistrict[d.id] : null;
  let interception;
  if (stats && ((stats.swats || 0) > 0 || (stats.drained || 0) > 0)) {
    const frac = clampNum(0.30 + 0.04 * (stats.drained || 0) + 0.015 * Math.min(20, stats.swats || 0), 0.10, 0.65);
    interception = Math.round(effective * frac);
  } else {
    interception = Math.round(effective * 0.45);
    notes.push('Illustrative: field interception at 45% of effective target (no live wave telemetry).');
  }
  const actual = Math.max(0, effective - interception);
  interception = effective - actual;
  return {
    id: d.id, name: d.name || d.id,
    baseline, shock, gross, prevention, effective, interception, actual,
    splitEstimated: false, notes,
  };
}

function synthesizeIllustrativeAudit() {
  const districts = resolveDistricts().map(d => synthesizeIllustrativeDistrict(d));
  return {
    source: 'illustrative',
    label: null,
    turn: null,
    districts,
    notes: ['Synthesized from current drivers; not recorded wave telemetry.'],
  };
}

function resolveAudit() {
  const G = getG();
  if (G && G.lastWaveAudit) {
    try {
      const live = normalizeLiveAudit(G.lastWaveAudit);
      if (live.districts.length) return live;
    } catch (e) { /* fall through to report / illustrative */ }
  }
  if (lastEventReport && Array.isArray(lastEventReport.districts) && lastEventReport.districts.length) {
    try {
      return normalizeLiveAudit({
        districts: lastEventReport.districts,
        source: 'live',
        label: lastEventReport.monthLabel || null,
      });
    } catch (e) { /* fall through to illustrative */ }
  }
  return synthesizeIllustrativeAudit();
}

const signedVal = (v, kind) => {
  const n = Math.round(v);
  if (kind === 'add') return `<span class="pos">+${fmtInt(n)}</span>`;
  if (kind === 'sub') return `<span class="neg">-${fmtInt(Math.abs(n))}</span>`;
  return `<span>${fmtInt(n)}</span>`;
};

const waterfallLedger = (a) => `
  <div class="ledger" aria-label="${esc(tr('epikd.audit.waterfall', 'Additive waterfall decomposition'))}">
    <div class="ledger-row"><span>${esc(tr('epikd.audit.baseline', 'EpiKD Baseline'))}</span>${signedVal(a.baseline, 'add')}</div>
    <div class="ledger-row"><span>${esc(tr('epikd.audit.shock', 'Climate / Shock Delta'))}</span>${signedVal(a.shock, 'add')}</div>
    <div class="ledger-row ledger-row--total"><span>${esc(tr('epikd.audit.gross', 'Gross Vector Pressure'))}</span>${signedVal(a.gross, 'plain')}</div>
    <div class="ledger-row"><span>${esc(tr('epikd.audit.prevention', 'Protocol Prevention (PSN / Trap / Fog)'))}</span>${signedVal(a.prevention, 'sub')}</div>
    <div class="ledger-row ledger-row--total"><span>${esc(tr('epikd.audit.effective', 'Effective Target'))}</span>${signedVal(a.effective, 'plain')}</div>
    <div class="ledger-row"><span>${esc(tr('epikd.audit.interception', 'Field Interception (Swats + Pool Drains)'))}</span>${signedVal(a.interception, 'sub')}</div>
    <div class="ledger-row ledger-row--total"><span>${esc(tr('epikd.audit.actual', 'Actual Cases Recorded'))}</span>${signedVal(a.actual, 'plain')}</div>
  </div>`;

function renderAuditTab() {
  const audit = resolveAudit();
  const isIllustrative = audit.source === 'illustrative';
  const filterId = auditFilter;
  const focusId = filterId || defaultDistrictId();
  const focus = audit.districts.find(x => x.id === focusId) || audit.districts[0];
  const notes = audit.districts.flatMap(x => x.notes || []);
  if (audit.districts.some(x => x.splitEstimated)) {
    notes.push('Prevention vs interception split estimated (audit payload did not carry both components).');
  }

  // Regional rollup across all 6 regencies (financial-style ledger).
  const rollupGrid = 'minmax(84px,1.3fr) repeat(6,minmax(38px,1fr))';
  const cellStyle = 'text-align:right;font-family:var(--font-mono);font-variant-numeric:tabular-nums;';
  const headCell = `${cellStyle}color:var(--text-muted);font-size:0.55rem;text-transform:uppercase;letter-spacing:0.06em;`;
  const totals = audit.districts.reduce((acc, x) => {
    acc.baseline += x.baseline; acc.shock += x.shock; acc.gross += x.gross;
    acc.prevention += x.prevention; acc.effective += x.effective;
    acc.interception += x.interception; acc.actual += x.actual;
    return acc;
  }, { baseline: 0, shock: 0, gross: 0, prevention: 0, effective: 0, interception: 0, actual: 0 });

  const rollupRows = audit.districts.map(x => `
    <div class="ledger-row${x.id === focusId ? ' ledger-row--total' : ''}" role="button" tabindex="0" data-epikd-audit-row="${esc(x.id || '')}"
         style="grid-template-columns:${rollupGrid};cursor:pointer;" title="${esc(tr('epikd.audit.focusRow', 'Show this regency in the waterfall above'))}">
      <span>${esc(x.name)}</span>
      <span style="${cellStyle}">${fmtInt(x.baseline)}</span>
      <span style="${cellStyle}">${x.shock >= 0 ? '+' : ''}${fmtInt(x.shock)}</span>
      <span style="${cellStyle}">${fmtInt(x.gross)}</span>
      <span style="${cellStyle}">${x.prevention ? '-' + fmtInt(x.prevention) : '0'}</span>
      <span style="${cellStyle}">${x.interception ? '-' + fmtInt(x.interception) : '0'}</span>
      <span style="${cellStyle}">${fmtInt(x.actual)}</span>
    </div>`).join('');

  const rollup = `
    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.audit.regional', 'Regional Rollup - All 6 Regencies'))}</div>
      <div class="ledger" style="margin-top:6px;overflow-x:auto;">
        <div class="ledger-row" style="grid-template-columns:${rollupGrid};background:var(--bg-elevated);">
          <span style="${headCell}text-align:left;">${esc(tr('epikd.audit.colRegency', 'Regency'))}</span>
          <span style="${headCell}">${esc(tr('epikd.audit.colBase', 'Base'))}</span>
          <span style="${headCell}">${esc(tr('epikd.audit.colShock', '+Shock'))}</span>
          <span style="${headCell}">${esc(tr('epikd.audit.colGross', 'Gross'))}</span>
          <span style="${headCell}">${esc(tr('epikd.audit.colPrev', '-Prev'))}</span>
          <span style="${headCell}">${esc(tr('epikd.audit.colIntc', '-Intc'))}</span>
          <span style="${headCell}">${esc(tr('epikd.audit.colActual', 'Actual'))}</span>
        </div>
        ${rollupRows}
        <div class="ledger-row ledger-row--total" style="grid-template-columns:${rollupGrid};">
          <span>${esc(tr('epikd.audit.total', 'TOTAL'))}</span>
          <span style="${cellStyle}">${fmtInt(totals.baseline)}</span>
          <span style="${cellStyle}">${totals.shock >= 0 ? '+' : ''}${fmtInt(totals.shock)}</span>
          <span style="${cellStyle}">${fmtInt(totals.gross)}</span>
          <span style="${cellStyle}">${totals.prevention ? '-' + fmtInt(totals.prevention) : '0'}</span>
          <span style="${cellStyle}">${totals.interception ? '-' + fmtInt(totals.interception) : '0'}</span>
          <span style="${cellStyle}">${fmtInt(totals.actual)}</span>
        </div>
      </div>
    </div>`;

  const sourceChip = isIllustrative
    ? `<span style="${WARN_CHIP_STYLE}">${esc(tr('epikd.audit.illustrativeChip', 'Illustrative'))}</span>`
    : `<span style="${CHIP_STYLE}">${esc(tr('epikd.audit.liveChip', 'Last wave'))}</span>`;
  const sourceLine = isIllustrative
    ? tr('epikd.audit.sourceIllustrative', 'Illustrative example - synthesized from current drivers (source: illustrative). Play a wave to record a real audit.')
    : (audit.label
        ? `Last wave audit - ${audit.label}`
        : tr('epikd.audit.sourceLive', 'Last wave audit - recorded wave telemetry.'));

  const filterChip = filterId
    ? `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:0.62rem;color:var(--text-secondary);">
         <span>${esc(tr('epikd.audit.filteredTo', 'Filtered to'))}: <strong style="color:var(--accent-bio);">${esc((focus && focus.name) || filterId)}</strong></span>
         <button type="button" data-epikd-clear-audit-filter style="${MINI_BTN_STYLE}">${esc(tr('epikd.audit.showAll', 'Show all regencies'))}</button>
       </div>`
    : '';

  const notesHtml = notes.length
    ? `<ul style="margin:6px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:3px;">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`
    : '';

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <h3 style="margin:0;">${esc(tr('epikd.audit.title', 'Wave Attribution Ledger'))}</h3>
      ${sourceChip}
    </div>
    <div style="${NOTE_STYLE}">${esc(sourceLine)}</div>
    ${filterChip}

    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.audit.waterfallFor', 'Waterfall - regency'))} <span style="color:var(--accent-bio);">${esc(focus ? focus.name : '')}</span></div>
      <div style="margin-top:6px;">${focus ? waterfallLedger(focus) : `<div style="${NOTE_STYLE}">${esc(tr('epikd.audit.noData', 'No audit data available.'))}</div>`}</div>
    </div>

    ${rollup}

    ${notesHtml ? `<div><div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.audit.notes', 'Reading the ledger'))}</div>${notesHtml}</div>` : ''}
    <div style="${NOTE_STYLE}">${esc(tr('epikd.audit.note', 'Additive decomposition for transparency. Values are simulation telemetry, not clinical estimates.'))}</div>`;
}

/* ---------------------------------------------------------------------
   TAB 4 — Field Manual
   --------------------------------------------------------------------- */
function renderManualTab() {
  const lang = getLang();

  const archetypes = [
    {
      key: 'aedes', color: '#38BDF8', variant: 'standard',
      name: tr('epikd.manual.arch.aedes.name', 'Standard Aedes'),
      trait: tr('epikd.manual.arch.aedes.trait', '1 HP. Baseline biter; arrives in steady waves. Swat on sight; drained pools thin the next brood.'),
    },
    {
      key: 'flanker', color: '#F59E0B', variant: 'flanker',
      name: tr('epikd.manual.arch.flanker.name', 'Monsoon Flanker'),
      trait: tr('epikd.manual.arch.flanker.trait', '1 HP. Weaves laterally across flight lanes between swats. Lead your cursor; drag-swipes track it best.'),
    },
    {
      key: 'queen', color: '#D946EF', variant: 'queen',
      name: tr('epikd.manual.arch.queen.name', 'Brood Queen'),
      trait: tr('epikd.manual.arch.queen.trait', '2 HP. Slow, swollen carrier; first hit cracks the husk, second finishes. Prioritize before she seeds pools.'),
    },
    {
      key: 'viremic', color: '#EF4444', variant: 'viremic',
      name: tr('epikd.manual.arch.viremic.name', 'Viremic Vector'),
      trait: tr('epikd.manual.arch.viremic.trait', '1 HP, crimson aura. Every bite lands as 2x ICU load. Intercept first, count beds later.'),
    },
  ];
  const archHtml = archetypes.map(a => `
    <div style="display:flex;gap:12px;align-items:center;border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:8px 10px;background:var(--bg-surface);">
      <div style="flex:0 0 auto;">${ICON.mosquito(a.color, 40, a.variant)}</div>
      <div>
        <div style="color:var(--text-primary);font-weight:700;font-size:0.74rem;letter-spacing:0.04em;">${esc(a.name)}</div>
        <div style="font-size:0.66rem;color:var(--text-secondary);line-height:1.5;">${esc(a.trait)}</div>
      </div>
    </div>`).join('');

  const stackFactor = (GAME_RULES.psnFactor * 0.85).toFixed(2);
  const synergyRows = [
    { icon: ICON.drip, text: tr('epikd.manual.syn.psnTrap', `PSN + Ovitrap stack multiplicatively: PSN x${GAME_RULES.psnFactor} then Ovitrap auto-capture x0.85, combined x${stackFactor} pressure. They do not add; deploy both for compounding suppression.`) },
    { icon: ICON.fog, text: tr('epikd.manual.syn.fog', `Thermal Fogging knocks down adults only. It never cuts pools at the source; back-to-back fogging nudges the ecology penalty (rebound breeding and reduced long-term suppression). Alternate with pool drains (x${GAME_RULES.drainFactor} each).`) },
    { icon: ICON.trap, text: tr('epikd.manual.syn.trap', 'Ovitraps work autonomously during the wave; PSN needs the field action. Sequencing PSN before trap placement front-loads the multiplicative stack.') },
    { icon: ICON.clinic, text: tr('epikd.manual.syn.clinic', 'Field Triage Wards expand bed surge and blunt fever panic; they do not stop transmission. Pair with PSN for containment, not as a substitute.') },
  ].map(r => `<li style="display:flex;gap:8px;align-items:flex-start;"><span style="flex:0 0 auto;color:var(--accent-bio);margin-top:1px;">${r.icon}</span><span>${esc(r.text)}</span></li>`).join('');

  const doctrineHtml = (DOCTRINES || []).map(doc => `
    <div style="border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:8px 10px;background:var(--bg-surface);">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="color:var(--accent-primary);">${ICON.shield}</span>
        <strong style="color:var(--text-primary);font-size:0.74rem;letter-spacing:0.04em;">${esc(pick(doc.name))}</strong>
      </div>
      <div style="font-size:0.64rem;color:var(--text-muted);margin:4px 0 2px;text-transform:uppercase;letter-spacing:0.08em;">${esc(pick(doc.identity))}</div>
      <div style="font-size:0.68rem;color:var(--text-secondary);line-height:1.5;">${esc(pick(doc.summary))}</div>
    </div>`).join('');

  const controlGroups = [
    {
      title: tr('epikd.manual.controls.ops', 'Mode 1 - Monsoon Operations'),
      rows: [
        tr('epikd.manual.controls.ops.1', 'Mouse: click or drag to swat. Space or right-click fires Containment Spray.'),
        tr('epikd.manual.controls.ops.2', 'Keys 1-5 toggle protocols: PSN, Ovitraps, Fogging, Triage Ward, Surveillance Sweep.'),
        tr('epikd.manual.controls.ops.3', 'W triggers a mid-wave ward surge. A opens this audit ledger from the report screen.'),
        tr('epikd.manual.controls.ops.touch', 'Touch: tap to swat, drag to swipe, on-screen spray button for Containment Spray.'),
      ],
    },
    {
      title: tr('epikd.manual.controls.board', 'Mode 2 - Crisis Board'),
      rows: [
        tr('epikd.manual.controls.board.1', 'Click a district to dispatch against it; click a shared border to set a Quarantine Cordon (2 weeks).'),
        tr('epikd.manual.controls.board.2', 'Keys 1-6 select the action: PSN, Ovitraps, Ward Surge, Larvicide, Surveillance, Quarantine.'),
        tr('epikd.manual.controls.board.3', 'Enter commits the week. 3 AP per week, 1 AP may carry over.'),
        tr('epikd.manual.controls.board.touch', 'Touch: tap districts and borders; action bar along the bottom; confirm button commits the week.'),
      ],
    },
    {
      title: tr('epikd.manual.controls.blitz', 'Mode 3 - Outbreak Blitz'),
      rows: [
        tr('epikd.manual.controls.blitz.1', '150 seconds on the clock. Click or drag to swat; Space fires the spray rail.'),
        tr('epikd.manual.controls.blitz.2', 'Combo builds on consecutive swats and decays after ~2.2s idle; tier multipliers up to x5.'),
        tr('epikd.manual.controls.blitz.3', 'Crates drop mid-run; Airstrike arms when the rail is full. Final 30 seconds run hot.'),
        tr('epikd.manual.controls.blitz.touch', 'Touch: same field - tap/drag to swat, spray button bottom-right, crates tap to claim.'),
      ],
    },
  ];
  const controlsHtml = controlGroups.map(g => `
    <div style="border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:8px 10px;background:var(--bg-surface);">
      <div style="color:var(--text-primary);font-weight:700;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;">${esc(g.title)}</div>
      <ul style="margin:6px 0 0;padding-left:16px;display:flex;flex-direction:column;gap:4px;font-size:0.68rem;">${g.rows.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>`).join('');

  return `
    <h3>${esc(tr('epikd.manual.title', 'Field Manual'))}</h3>
    <div style="${NOTE_STYLE}">${esc(tr('epikd.manual.intro', 'Pocket reference for vector archetypes, protocol synergies, doctrines and controls.'))}</div>

    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.manual.archetypesTitle', 'Mosquito Archetypes'))}</div>
      <div style="margin-top:6px;display:flex;flex-direction:column;gap:6px;">${archHtml}</div>
      <div style="${NOTE_STYLE}margin-top:6px;">${esc(t('epikd.manual.archetypes') !== 'epikd.manual.archetypes' ? t('epikd.manual.archetypes') : 'Standard Aedes (1 HP), Monsoon Flanker (weave), Brood Queen (2 HP), Viremic Vector (crimson aura, 2x ICU load).')}</div>
    </div>

    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.manual.synergiesTitle', 'Protocol Synergies'))}</div>
      <ul style="margin:6px 0 0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:0.68rem;color:var(--text-secondary);">${synergyRows}</ul>
      <div style="${NOTE_STYLE}margin-top:6px;">${esc(t('epikd.manual.synergies') !== 'epikd.manual.synergies' ? t('epikd.manual.synergies') : '')}</div>
    </div>

    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.manual.doctrinesTitle', 'Commander Doctrines'))}</div>
      <div style="margin-top:6px;display:flex;flex-direction:column;gap:6px;">${doctrineHtml}</div>
      <div style="${NOTE_STYLE}margin-top:6px;">${esc(t('epikd.manual.doctrines') !== 'epikd.manual.doctrines' ? t('epikd.manual.doctrines') : '')}</div>
    </div>

    <div>
      <div style="${SECTION_LABEL_STYLE}">${esc(tr('epikd.manual.controlsTitle', 'Controls by Mode'))}</div>
      <div style="margin-top:6px;display:flex;flex-direction:column;gap:6px;">${controlsHtml}</div>
      <div style="${NOTE_STYLE}margin-top:6px;">${esc(t('epikd.manual.controls') !== 'epikd.manual.controls' ? t('epikd.manual.controls') : '')}</div>
    </div>

    <div style="${CALLOUT_STYLE}">
      <strong style="color:var(--accent-bio);letter-spacing:0.08em;text-transform:uppercase;font-size:0.6rem;">${esc(tr('epikd.manual.optionalTitle', 'Optional companion'))}</strong><br>
      ${esc(tr('epikd.manual.optionalBody', 'EpiKD Lab is a reference drawer, never a gate. Nothing in here pauses or interrupts a wave, and no badge, toast or counter fires while you are under attack. Open it between actions, or after the debrief.'))}
    </div>`;
}

/* ---------------------------------------------------------------------
   Drawer construction & behaviour
   --------------------------------------------------------------------- */
const PANEL_RENDERERS = Object.freeze({
  model: renderModelTab,
  drivers: renderDriversTab,
  audit: renderAuditTab,
  manual: renderManualTab,
});

function panelEl(tab) {
  return drawerEl ? drawerEl.querySelector(`[data-panel="${tab}"]`) : null;
}

function renderPanel(tab) {
  const panel = panelEl(tab);
  if (!panel) return;
  const renderer = PANEL_RENDERERS[tab];
  try {
    panel.innerHTML = renderer ? renderer() : '';
  } catch (e) {
    panel.innerHTML = `<div style="${WARN_CALLOUT_STYLE}">${esc(tr('epikd.renderError', 'This section failed to render.'))} <span style="font-family:var(--font-mono);">${esc(e && e.message ? e.message : String(e))}</span></div>`;
  }
  wirePanel(tab, panel);
}

function renderActivePanel() {
  renderPanel(activeTab);
}

function wirePanel(tab, panel) {
  if (tab === 'drivers') {
    const select = panel.querySelector('[data-epikd-drivers-select]');
    if (select) {
      select.addEventListener('change', () => {
        driversDistrictId = select.value || null;
        renderPanel('drivers');
      });
    }
  } else if (tab === 'audit') {
    const clear = panel.querySelector('[data-epikd-clear-audit-filter]');
    if (clear) {
      clear.addEventListener('click', () => { auditFilter = null; renderPanel('audit'); });
    }
    const rows = panel.querySelectorAll('[data-epikd-audit-row]');
    rows.forEach(row => {
      const activate = () => {
        const id = row.getAttribute('data-epikd-audit-row');
        auditFilter = id || null;
        renderPanel('audit');
      };
      row.addEventListener('click', activate);
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(); }
      });
    });
  }
}

function setTab(tab) {
  if (!TABS.includes(tab)) tab = 'model';
  activeTab = tab;
  if (!drawerEl) return;
  const tabs = drawerEl.querySelectorAll('.drawer-tab');
  tabs.forEach(btn => {
    const isActive = btn.getAttribute('data-tab') === tab;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.tabIndex = isActive ? 0 : -1;
  });
  for (const name of TABS) {
    const panel = panelEl(name);
    if (panel) {
      const isActive = name === tab;
      panel.hidden = !isActive;
      panel.style.display = isActive ? '' : 'none';
    }
  }
  renderPanel(tab);
}

function buildDrawer() {
  if (drawerEl || typeof document === 'undefined') return drawerEl;

  scrimEl = document.createElement('div');
  scrimEl.className = 'epikd-scrim';
  scrimEl.setAttribute('aria-hidden', 'true');
  scrimEl.setAttribute('data-epikd-close', '');

  // Reuse the static <aside id="epikdLabDrawer"> shell from index.html when present
  // (single-ID contract); otherwise create one.
  const existing = document.getElementById('epikdLabDrawer');
  const el = existing || document.createElement('aside');
  el.id = 'epikdLabDrawer';
  el.className = 'epikd-drawer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'false');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('aria-labelledby', 'epikdDrawerTitle');

  const tabButtons = TABS.map(name => `
    <button type="button" class="drawer-tab${name === 'model' ? ' is-active' : ''}" role="tab"
            id="epikdTab-${name}" data-tab="${name}" aria-controls="epikdPanel-${name}"
            aria-selected="${name === 'model' ? 'true' : 'false'}">
      ${esc(tr(TAB_LABEL_KEYS[name], TAB_LABEL_FALLBACK[name]))}
    </button>`).join('');

  const panels = TABS.map(name => `
    <section class="epikd-panel" id="epikdPanel-${name}" data-panel="${name}" role="tabpanel"
             aria-labelledby="epikdTab-${name}"${name === 'model' ? '' : ' hidden style="display:none"'}></section>`).join('');

  el.innerHTML = `
    <div class="drawer-head">
      <div class="drawer-title" id="epikdDrawerTitle">${ICON.flask}<span>${esc(t('epikd.title') !== 'epikd.title' ? t('epikd.title') : 'EpiKD Lab & Field Manual')}</span></div>
      <button type="button" class="drawer-close" data-epikd-close aria-label="${esc(t('epikd.close') !== 'epikd.close' ? t('epikd.close') : 'Close')}">${ICON.close}</button>
    </div>
    <div style="padding:6px 16px 0;font-size:0.62rem;color:var(--text-muted);border-bottom:1px solid var(--border-subtle);padding-bottom:8px;">${esc(t('epikd.subtitle') !== 'epikd.subtitle' ? t('epikd.subtitle') : 'Model telemetry, district drivers and wave audits for the curious commander.')}</div>
    <div class="drawer-tabs" role="tablist" aria-label="${esc(tr('epikd.tabsLabel', 'EpiKD Lab sections'))}">${tabButtons}</div>
    <div class="drawer-body">${panels}</div>`;

  el.querySelectorAll('.drawer-tab').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.getAttribute('data-tab')));
    btn.addEventListener('keydown', (ev) => {
      const idx = TABS.indexOf(activeTab);
      let next = null;
      if (ev.key === 'ArrowRight') next = TABS[(idx + 1) % TABS.length];
      else if (ev.key === 'ArrowLeft') next = TABS[(idx - 1 + TABS.length) % TABS.length];
      else if (ev.key === 'Home') next = TABS[0];
      else if (ev.key === 'End') next = TABS[TABS.length - 1];
      if (next) { ev.preventDefault(); setTab(next); const b = el.querySelector(`.drawer-tab[data-tab="${next}"]`); if (b) b.focus(); }
    });
  });

  document.body.appendChild(scrimEl);
  if (!existing) document.body.appendChild(el);
  drawerEl = el;
  return el;
}

function wireGlobal() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (wireGlobal._done) return;
  wireGlobal._done = true;

  // Delegated close handling (drawer close button + scrim).
  document.addEventListener('click', (ev) => {
    const closer = ev.target && ev.target.closest ? ev.target.closest('[data-epikd-close]') : null;
    if (closer) { ev.preventDefault(); closeEpikdLab(); return; }
    // #epikdLabDrawer pill toggle: any .epikd-pill / [data-epikd-toggle] toggles.
    const pill = ev.target && ev.target.closest ? ev.target.closest('.epikd-pill,[data-epikd-toggle],[data-open-epikd]') : null;
    if (pill) {
      ev.preventDefault();
      if (drawerEl && drawerEl.classList.contains('open')) closeEpikdLab();
      else openEpikdLab('model');
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && drawerEl && drawerEl.classList.contains('open')) closeEpikdLab();
  });

  window.addEventListener('dd:open-epikd', (ev) => {
    const detail = (ev && ev.detail) || {};
    const tab = TABS.includes(detail.tab) ? detail.tab : 'model';
    if (detail && detail.districtId) { driversDistrictId = detail.districtId; auditFilter = detail.districtId; }
    openEpikdLab(tab);
  });

  window.addEventListener('dd:open-epikd-audit', (ev) => {
    const detail = (ev && ev.detail) || {};
    if (detail.report && Array.isArray(detail.report.districts)) lastEventReport = detail.report;
    if (detail.districtId) auditFilter = detail.districtId;
    else if (detail.report && Array.isArray(detail.report.districts) && detail.report.districts.length === 1) {
      auditFilter = detail.report.districts[0].id || null;
    }
    openEpikdLab('audit');
  });

  window.addEventListener('dd:langchange', () => {
    if (drawerEl && drawerEl.classList.contains('open')) renderActivePanel();
  });
}

function ensureDrawer() {
  wireGlobal();
  return buildDrawer();
}

/**
 * Open the EpiKD Lab drawer.
 * @param {'model'|'drivers'|'audit'|'manual'} [initialTab='model']
 */
export function openEpikdLab(initialTab = 'model') {
  const el = ensureDrawer();
  if (!el) return null;
  const tab = TABS.includes(initialTab) ? initialTab : 'model';
  lastFocus = (typeof document !== 'undefined' && document.activeElement) ? document.activeElement : null;
  setTab(tab);
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  if (scrimEl) scrimEl.classList.add('open');
  const closeBtn = el.querySelector('[data-epikd-close]');
  if (closeBtn && typeof closeBtn.focus === 'function') {
    try { closeBtn.focus({ preventScroll: true }); } catch (e) { closeBtn.focus(); }
  }
  return el;
}

/** Hide the EpiKD Lab drawer. */
export function closeEpikdLab() {
  if (!drawerEl) return;
  drawerEl.classList.remove('open');
  drawerEl.setAttribute('aria-hidden', 'true');
  if (scrimEl) scrimEl.classList.remove('open');
  if (lastFocus && typeof lastFocus.focus === 'function') {
    try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* focus restore best-effort */ }
  }
}

/**
 * Open the drawer directly on the Waterfall Audit tab, filtered to one
 * district. Pass a district id from DISTRICT_DEFS (e.g. 'klaten').
 * @param {string} districtId
 */
export function openWaveAttributionAudit(districtId) {
  auditFilter = typeof districtId === 'string' && districtId ? districtId : null;
  return openEpikdLab('audit');
}

/* Auto-wire global listeners when imported in a browser context. Purely
   additive: never opens the drawer by itself (badge-quiet guarantee). */
if (typeof document !== 'undefined') {
  try { wireGlobal(); } catch (e) { /* wiring is best-effort */ }
}
