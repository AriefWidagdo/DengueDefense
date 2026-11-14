/* =====================================================================
   Dengue Defense — Field Edition · Entrypoint / Shell Router
   RAF loop, canvas + resize via map-renderer, mode router (hub -> modes),
   URL params (?seed / ?mode / ?doctrine / ?lang), pointer + keyboard
   dispatch in map coordinates, pause overlay, language switch, toasts.

   Sibling Wave 3 modules (js/ui/hud.js, js/ui/modals.js,
   js/ui/epikd-lab.js) are loaded dynamically and every call into them is
   guarded; when absent, internal fallbacks keep the shell functional.
   Zero emojis. Gameplay copy stays diegetic (Satgas DBD command voice).
   ===================================================================== */

import {
  MODES, DOCTRINES, MUTATORS,
  getG, getW, setG, setW,
  randomSeedWord, parseSeed,
} from './state.js';
import { MapRenderer, getView, toMap } from './map-renderer.js';
import { t, getLang, setLang, toggleLanguage, applyStaticI18n } from './i18n.js';
import {
  setAudioEnabled, isAudioEnabled,
  setHapticsEnabled, isHapticsEnabled,
} from './audio.js';
import { LB_API, submitScore, openLeaderboard, closeLeaderboard } from './leaderboard.js';
import { OperationsMode } from './modes/operations.js';
import { CrisisBoardMode } from './modes/crisis-board.js';
import { BlitzMode } from './modes/blitz.js';

/* ---------------- DOM helpers ---------------- */
const $ = (id) => document.getElementById(id);
const SCREEN_IDS = ['hubScreen', 'dispatchScreen', 'reportScreen', 'perkScreen', 'pauseScreen', 'badgeScreen', 'leaderboardScreen', 'endScreen'];

function setScreenVisible(id, visible) {
  const el = $(id);
  if (!el) return;
  el.hidden = !visible;
  el.classList.toggle('hidden', !visible);
}
function hideAllScreens() { for (const id of SCREEN_IDS) setScreenVisible(id, false); }
function showOnly(id) { hideAllScreens(); if (id) setScreenVisible(id, true); }
function hideScreen(id) { setScreenVisible(id, false); }
function showScreen(id) { setScreenVisible(id, true); }

function dispatchDd(name, detail) {
  try {
    const Ctor = typeof window.CustomEvent === 'function' ? window.CustomEvent : null;
    if (!Ctor) return false;
    window.dispatchEvent(new Ctor(name, { detail: detail || {} }));
    return true;
  } catch (e) { return false; }
}

function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } }

/* ---------------- URL params (quick boot / test hooks) ---------------- */
const params = (() => {
  try { return new URLSearchParams(window.location.search); } catch (e) { return new URLSearchParams(''); }
})();
const urlSeed = params.get('seed');
const urlMode = params.get('mode');
const urlDoctrine = params.get('doctrine');
const urlLang = params.get('lang');
const VALID_MODES = new Set(['operations', 'crisis_board', 'blitz']);
const paramMode = VALID_MODES.has(String(urlMode || '')) ? String(urlMode) : null;
const paramDoctrine = DOCTRINES.some(d => d.id === urlDoctrine) ? urlDoctrine : null;
if (urlLang === 'en' || urlLang === 'id') setLang(urlLang);

/* ---------------- Mode registry & shell state ---------------- */
const MODE_REGISTRY = Object.freeze({
  operations: OperationsMode,
  crisis_board: CrisisBoardMode,
  blitz: BlitzMode,
});

let renderer = null;
let cachedCtx = null;
let currentModeId = null;
let currentMode = null;
let paused = false;
let gameOverFired = false;
let lastFrame = 0;
let hudTimer = 0;
let panelCollapsed = false;
let uiHud = null;      // js/ui/hud.js sibling (optional)
let uiModals = null;   // js/ui/modals.js sibling (optional, event-driven)
let epikdLab = null;   // js/ui/epikd-lab.js sibling (optional)

let selectedMode = paramMode || 'operations';
let selectedDoctrine = paramDoctrine || null;
const selectedMutators = new Set();
let seedLock = '';

/* ---------------- Toasts / banners (hud sibling or fallback) ---------------- */
let toastTimer = 0;
let bannerTimer = 0;
function showToast(msg, isError) {
  if (uiHud && typeof uiHud.showToast === 'function') {
    try { uiHud.showToast(msg, isError); return; } catch (e) { /* fall through */ }
  }
  const el = $('toast');
  if (!el) return;
  el.textContent = msg == null ? '' : String(msg);
  el.classList.toggle('toast--error', !!isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
function showBanner(msg) {
  if (uiHud && typeof uiHud.showBanner === 'function') {
    try { uiHud.showBanner(msg); return; } catch (e) { /* fall through */ }
  }
  const el = $('banner');
  if (!el) return;
  el.textContent = msg == null ? '' : String(msg);
  el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ---------------- Best scores (hub) ---------------- */
const bestKey = (mode) => `dd_best_${mode}`;
function loadBest(mode) {
  const n = Number(storageGet(bestKey(mode)));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function saveBest(mode, score) {
  const prev = loadBest(mode);
  if (score > prev) { storageSet(bestKey(mode), String(Math.floor(score))); return true; }
  return false;
}
function bestI18nKey(mode) {
  return mode === 'operations' ? 'hub.mode1.best' : mode === 'crisis_board' ? 'hub.mode2.best' : 'hub.mode3.best';
}
function refreshHubBests() {
  document.querySelectorAll('[data-best-mode]').forEach((el) => {
    const mode = el.getAttribute('data-best-mode');
    el.textContent = t(bestI18nKey(mode), { count: loadBest(mode) });
  });
}

/* ---------------- Hub wiring ---------------- */
function paintModeCards() {
  document.querySelectorAll('.mode-card').forEach((card) => {
    const active = card.getAttribute('data-mode') === selectedMode;
    card.classList.toggle('is-selected', active);
    card.setAttribute('aria-pressed', String(active));
  });
}
function paintDoctrineCards() {
  document.querySelectorAll('.doctrine-card').forEach((card) => {
    const active = card.getAttribute('data-doctrine') === selectedDoctrine;
    card.classList.toggle('is-selected', active);
    card.setAttribute('aria-pressed', String(active));
  });
}
function renderMutators() {
  const grid = $('hubMutatorGrid');
  if (!grid) return;
  grid.textContent = '';
  for (const m of MUTATORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mutator-chip' + (selectedMutators.has(m.id) ? ' is-active' : '');
    btn.setAttribute('data-mutator', m.id);
    btn.setAttribute('aria-pressed', String(selectedMutators.has(m.id)));
    const name = document.createElement('span');
    name.className = 'mutator-chip-name';
    name.textContent = t(`hub.mutator.${m.id}.name`);
    const desc = document.createElement('span');
    desc.className = 'mutator-chip-desc';
    desc.textContent = t(`hub.mutator.${m.id}.desc`);
    btn.append(name, desc);
    btn.addEventListener('click', () => {
      if (selectedMutators.has(m.id)) selectedMutators.delete(m.id); else selectedMutators.add(m.id);
      renderMutators();
    });
    grid.appendChild(btn);
  }
}
function resolveSeed(opts) {
  const o = opts || {};
  if (o.seedStr != null) return String(o.seedStr);
  if (urlSeed) return String(urlSeed);
  if (seedLock) return seedLock;
  const typed = String($('hubSeedInput')?.value || '').trim();
  return typed || randomSeedWord();
}

/* ---------------- Mode lifecycle ---------------- */
function safeSnapshot() {
  if (!currentMode || typeof currentMode.getHudSnapshot !== 'function') return null;
  try { return currentMode.getHudSnapshot(); } catch (e) { console.error('[main] getHudSnapshot failed', e); return null; }
}
function stopCurrentMode() {
  if (currentMode && typeof currentMode.dispose === 'function') {
    try { currentMode.dispose(); } catch (e) { console.warn('[main] dispose failed', e); }
  }
  currentMode = null;
  currentModeId = null;
  paused = false;
  document.body.classList.remove('mode-blitz', 'mode-operations', 'mode-crisis_board', 'phase-wave');
}
function startMode(id, opts) {
  const impl = MODE_REGISTRY[id];
  if (!impl) return false;
  stopCurrentMode();
  gameOverFired = false;
  const seedStr = resolveSeed(opts);
  const doctrine = (opts && opts.doctrine !== undefined) ? opts.doctrine : selectedDoctrine;
  const mutators = (opts && Array.isArray(opts.mutators)) ? opts.mutators.slice() : [...selectedMutators];
  currentModeId = id;
  currentMode = impl;
  selectedMode = id;
  try {
    impl.init({ seedStr, seed: parseSeed(seedStr), doctrine: doctrine || null, scenario: opts && opts.scenario, mutators });
  } catch (err) {
    console.error('[main] mode init failed', err);
    showToast('Mode failed to initialize', true);
    stopCurrentMode();
    showOnly('hubScreen');
    return false;
  }
  document.body.classList.toggle('mode-blitz', id === 'blitz');
  document.body.classList.toggle('mode-operations', id === 'operations');
  document.body.classList.toggle('mode-crisis_board', id === 'crisis_board');
  hideAllScreens();
  refreshHud(safeSnapshot());
  return true;
}
function exitToHub() {
  stopCurrentMode();
  hideAllScreens();
  showScreen('hubScreen');
  paintModeCards();
  paintDoctrineCards();
  refreshHubBests();
  renderMutators();
}

/* ---------------- Game over / end screen ---------------- */
function endGradeFor(score) {
  if (score >= 500000) return 'S';
  if (score >= 300000) return 'A';
  if (score >= 150000) return 'B';
  if (score >= 60000) return 'C';
  return 'D';
}
function gameOver(reason) {
  if (gameOverFired) return;
  gameOverFired = true;
  const prev = getG();
  const score = prev && Number.isFinite(prev.score) ? Math.round(prev.score) : 0;
  const result = reason || (prev && prev.result) || 'hospital';
  if (prev) setG({ ...prev, phase: 'over', result });   // mirrors window.G via state.js
  paused = false;
  hideScreen('pauseScreen');
  if (uiModals && typeof uiModals.closeAllModals === 'function') {
    try { uiModals.closeAllModals(); } catch (e) { /* ignore */ }
    lastOpsPhase = null;
  }
  const modeId = (getG() && getG().mode) || currentModeId || 'operations';
  const newBest = saveBest(modeId, score);
  const snap = safeSnapshot();
  const gradeEl = $('endGrade');
  if (gradeEl) {
    const grade = endGradeFor(score);
    gradeEl.textContent = grade;
    gradeEl.className = `end-grade end-grade--${grade.toLowerCase()}`;
  }
  const defeat = result === 'hospital' || result === 'collapse';
  const titleEl = $('endTitle');
  if (titleEl) titleEl.textContent = t(defeat ? 'end.defeat.title' : 'end.victory.title');
  const bodyEl = $('endBody');
  if (bodyEl) bodyEl.textContent = t(defeat ? 'end.defeat.body' : 'end.victory.body');
  const stats = {
    endScore: score,
    endBest: loadBest(modeId),
    endCasesPrevented: (snap && snap.casesPrevented) ?? (prev && prev.casesPrevented) ?? 0,
    endSwatted: (snap && snap.swatted) ?? (prev && prev.swatted) ?? 0,
  };
  for (const [id, value] of Object.entries(stats)) {
    const el = $(id);
    if (el) el.textContent = Number(value || 0).toLocaleString();
  }
  const nb = $('endNewBest');
  if (nb) nb.hidden = !newBest;
  try { window.LB_PENDING_SCORE = score; } catch (e) { /* ignore */ }
  hideAllScreens();
  if (uiModals && typeof uiModals.showEnd === 'function') {
    const G2 = getG();
    try {
      uiModals.showEnd({
        victory: !defeat,
        mode: modeId,
        score,
        grade: endGradeFor(score),
        seedStr: (G2 && G2.seedStr) || undefined,
        doctrine: G2 && G2.doctrine,
        scenario: G2 && G2.scenario,
        mutators: G2 && G2.mutators,
        casesPrevented: (snap && snap.casesPrevented) ?? (G2 && G2.casesPrevented),
        swatted: (snap && snap.swatted) ?? (G2 && G2.swatted),
        poolsDrained: (snap && snap.poolsDrained) ?? (G2 && G2.poolsDrained),
        cleanMonths: (snap && snap.cleanMonths) ?? (G2 && G2.cleanMonths),
        peakHeadroom: (snap && snap.peakHeadroom) ?? (G2 && G2.peakHeadroom),
        peakCombo: (snap && snap.peakCombo) ?? (G2 && G2.blitz && G2.blitz.peakCombo),
        kills: snap && snap.kills,
        survivalTime: snap && snap.survivalTime,
        clearBonus: snap && snap.clearBonus,
      }, () => {});
      refreshHud(safeSnapshot());
      return;
    } catch (e) { console.error('[main] showEnd failed', e); }
  }
  showScreen('endScreen');
  refreshHud(safeSnapshot());
}

/* ---------------- Pause ---------------- */
function canPause() { return !!(currentMode && currentMode.supportsPause !== false); }
function setPaused(next) {
  const want = !!next;
  if (want && !canPause()) return;
  paused = want;
  const G = getG();
  if (G) setG({ ...G, paused });
  if (paused) {
    if (uiModals && typeof uiModals.openPause === 'function') {
      try {
        uiModals.openPause(
          () => setPaused(false),
          (kind) => {
            if (kind === 'restart') {
              const G2 = getG();
              startMode(currentModeId || 'operations', { seedStr: (G2 && G2.seedStr) || undefined });
            } else {
              exitToHub();
            }
          },
        );
        return;
      } catch (e) { /* fall through to static pause screen */ }
    }
    showScreen('pauseScreen');
  } else {
    hideScreen('pauseScreen');
    if (uiModals && typeof uiModals.closeAllModals === 'function') {
      try { uiModals.closeAllModals(); } catch (e) { /* ignore */ }
      lastOpsPhase = null;   // force phase screens to re-surface on the next tick
    }
  }
}
function togglePause() { setPaused(!paused); }

/* ---------------- EpiKD Lab drawer (fallback; sibling preferred) ---------------- */
function epikdDrawerEl() { return $('epikdLabDrawer'); }
function isEpikdOpen() {
  const d = epikdDrawerEl();
  return !!d && (d.classList.contains('open') || d.getAttribute('aria-hidden') === 'false');
}
function activateEpikdTab(panelId) {
  const d = epikdDrawerEl();
  if (!d) return;
  d.querySelectorAll('.drawer-tab').forEach((tab) => {
    const active = tab.getAttribute('data-epikd-tab') === panelId;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  d.querySelectorAll('[role="tabpanel"]').forEach((panel) => {
    panel.hidden = panel.id !== panelId;
  });
}
const EPIXD_TAB_MAP = { epikdPanelModel: 'model', epikdPanelDrivers: 'drivers', epikdPanelAudit: 'audit', epikdPanelManual: 'manual' };
function setEpikdOpen(open, tabId) {
  const d = epikdDrawerEl();
  if (!d) return;
  if (epikdLab && typeof epikdLab.openEpikdLab === 'function' && open) {
    const tab = EPIXD_TAB_MAP[tabId] || tabId || 'model';
    try { epikdLab.openEpikdLab(tab); return; } catch (e) { /* fall through to DOM toggle */ }
  }
  if (epikdLab && typeof epikdLab.closeEpikdLab === 'function' && !open) {
    try { epikdLab.closeEpikdLab(); return; } catch (e) { /* fall through */ }
  }
  d.classList.toggle('open', !!open);
  d.setAttribute('aria-hidden', String(!open));
  if (open && tabId) activateEpikdTab(tabId);
}

/* ---------------- HUD (hud sibling or internal fallback) ---------------- */
const THREAT_KEYS = ['hud.threat.low', 'hud.threat.elevated', 'hud.threat.high', 'hud.threat.critical'];
const THREAT_CLASSES = ['tag tag--bio', 'tag tag--amber', 'tag tag--danger', 'tag tag--danger threat-critical'];
function normalizeThreatTier(value) {
  if (value == null) return 0;
  if (Number.isFinite(Number(value))) return Math.max(0, Math.min(3, Number(value)));
  const s = String(value).toLowerCase();
  if (s.includes('crit')) return 3;
  if (s.includes('high')) return 2;
  if (s.includes('elev') || s.includes('warn') || s.includes('mod')) return 1;
  return 0;
}
function refreshHud(snapArg) {
  const snap = snapArg !== undefined ? snapArg : safeSnapshot();
  if (uiHud && typeof uiHud.renderHud === 'function') {
    try { uiHud.renderHud(snap); return; } catch (e) { /* fall back to internal HUD */ }
  }
  const G = getG();
  const lang = getLang();
  const modeId = (snap && (snap.mode || snap.id)) || currentModeId || (G && G.mode) || 'operations';
  const modeDef = MODES.find((m) => m.id === modeId);
  const modeTextEl = $('hudModeText');
  if (modeTextEl) {
    modeTextEl.textContent = currentMode && modeDef && modeDef.name
      ? (modeDef.name[lang] || modeDef.name.en)
      : 'Satgas DBD';
  }
  const pill = $('hudScenarioPill');
  if (pill) {
    if (!snap) {
      pill.textContent = 'STANDBY';
    } else if (modeId === 'blitz') {
      pill.textContent = snap.timeLeftStr || t('hud.phase.blitz');
    } else if (modeId === 'crisis_board') {
      pill.textContent = t('hud.phase.week', { count: snap.week || 1 });
    } else {
      pill.textContent = [snap.monthLabel, snap.monthCounter].filter(Boolean).join(' · ') || 'NOV';
    }
  }
  const seedTag = $('hudSeedTag');
  if (seedTag) seedTag.textContent = String((G && G.seedStr) || (snap && snap.seedStr) || '—').toUpperCase();
  const scoreEl = $('hudScore');
  if (scoreEl) scoreEl.textContent = Number((snap && snap.score) ?? (G && G.score) ?? 0).toLocaleString();
  // Funds vs AP vitals (mode-aware)
  const fundsWrap = $('hudFundsWrap');
  const apWrap = $('hudApWrap');
  const funds = snap && Number.isFinite(Number(snap.funds)) ? Math.round(snap.funds) : null;
  const ap = snap && Number.isFinite(Number(snap.ap)) ? Math.round(snap.ap) : null;
  if (fundsWrap) {
    fundsWrap.hidden = funds == null;
    if (funds != null) $('hudFunds').textContent = String(funds);
  }
  if (apWrap) {
    apWrap.hidden = ap == null;
    if (ap != null) $('hudAp').textContent = String(ap);
  }
  // Hospital surge gauge
  const load = Number((snap && (snap.icuLoad ?? snap.hospitalLoad)) ?? (G && G.hospitalLoad) ?? 0);
  const cap = Number((snap && (snap.icuCap ?? snap.hospitalEffectiveCap ?? snap.hospitalCap)) ?? (G && G.hospitalCap) ?? 240);
  const pct = cap > 0 ? Math.max(0, Math.min(100, (load / cap) * 100)) : 0;
  const icuVal = $('hudIcuValue');
  if (icuVal) icuVal.textContent = `${Math.round(load)}/${Math.round(cap)}`;
  const fill = $('hudSurgeFill');
  if (fill) {
    fill.style.setProperty('--surge', `${pct}%`);
    fill.classList.toggle('is-warn', pct > 65 && pct <= 85);
    fill.classList.toggle('is-danger', pct > 85 && pct <= 95);
    fill.classList.toggle('is-critical', pct > 95);
  }
  // Tactical rail
  const districts = (snap && Array.isArray(snap.districts)) ? snap.districts : [];
  const selId = snap && snap.selectedDistrict;
  const sel = districts.find((d) => d && d.id === selId) || null;
  const nameEl = $('panelDistrictName');
  if (nameEl) nameEl.textContent = sel ? String(sel.name || sel.id).toUpperCase() : '—';
  const threatEl = $('panelThreatTag');
  if (threatEl) {
    const tier = normalizeThreatTier(sel ? (sel.risk ?? sel.threat ?? sel.riskName) : (snap && snap.threatTier));
    threatEl.textContent = t(THREAT_KEYS[tier]);
    threatEl.className = THREAT_CLASSES[tier];
    threatEl.id = 'panelThreatTag';
  }
  const mitEl = $('panelMitigation');
  if (mitEl) mitEl.textContent = sel && Number.isFinite(Number(sel.mitigationPct)) ? `${Math.round(sel.mitigationPct)}%` : '—';
  const predEl = $('panelPrediction');
  if (predEl) {
    if (sel && sel.predLow != null && sel.predHigh != null) predEl.textContent = `FA ${sel.predLow}-${sel.predHigh}`;
    else if (sel && Number.isFinite(Number(sel.median))) predEl.textContent = `MEDIAN ${Math.round(sel.median)}`;
    else if (snap && snap.peakCombo != null) predEl.textContent = `COMBO x${Number(snap.comboTier || 1).toFixed(1)} · ${snap.kills || 0} KOs`;
    else predEl.textContent = '—';
  }
  const commitBtn = $('panelCommitBtn');
  if (commitBtn) {
    commitBtn.textContent = modeId === 'crisis_board' ? t('hud.commitTurn') : t('hud.launchWave');
    commitBtn.dataset.mode = modeId;
  }
}

/* ---------------- Terminal-state watchdog ----------------
   OperationsMode.victory() and CrisisBoardMode never call window.gameOver
   directly, so detect their terminal snapshot phases here. Modes that do
   call window.gameOver (operations hospital defeat, blitz) set
   gameOverFired first, making this a no-op for them. */
function syncTerminalState(snap) {
  if (gameOverFired || !snap || !currentModeId) return;
  const phase = snap.phase;
  if (phase !== 'over' && phase !== 'end') return;
  let reason = 'victory';
  if (currentModeId === 'operations') {
    reason = snap.result === 'victory' ? 'victory' : 'hospital';
  } else if (currentModeId === 'crisis_board') {
    reason = snap.result === 'win' ? 'victory' : (snap.lossReason || 'hospital');
  } else {
    reason = snap.victory ? 'clear' : 'hospital';
  }
  gameOver(reason);
}

/* ---------------- Fallback screen bridge (directive/report/perk) ----------------
   When js/ui/modals.js is absent, surface the three mode1 phase screens
   from getHudSnapshot(). Content is rebuilt only when it changes. */
let lastDirectiveKey = '';
let lastPerkKey = '';
let lastOpsPhase = null;
function syncPhaseScreens(snap) {
  if (!snap || currentModeId !== 'operations') {
    if (currentModeId !== 'operations') {
      hideScreen('dispatchScreen'); hideScreen('reportScreen'); hideScreen('perkScreen');
      lastDirectiveKey = ''; lastPerkKey = ''; lastOpsPhase = null;
    }
    return;
  }
  const phase = snap.phase;
  // Sibling path: modals.js renders/hides the phase screens itself; call its
  // show* functions only on rising edges so internal timers are not reset.
  if (uiModals) {
    if (phase === 'briefing' && snap.directive && typeof uiModals.showDispatch === 'function') {
      if (lastOpsPhase !== 'briefing') {
        try { uiModals.showDispatch(snap.directive, () => {}); } catch (e) { console.error('[main] showDispatch failed', e); }
      }
    } else if (phase === 'report' && typeof uiModals.showReport === 'function') {
      if (lastOpsPhase !== 'report') {
        try { uiModals.showReport(snap.report || {}, () => {}); } catch (e) { console.error('[main] showReport failed', e); }
      }
    } else if (phase === 'perk' && typeof uiModals.showPerkPick === 'function') {
      if (lastOpsPhase !== 'perk') {
        try { uiModals.showPerkPick(snap.perkChoices || [], () => {}); } catch (e) { console.error('[main] showPerkPick failed', e); }
      }
    }
    lastOpsPhase = phase;
    return;
  }
  // BRIEFING -> #dispatchScreen
  const showDispatch = phase === 'briefing' && !!snap.directive;
  setScreenVisible('dispatchScreen', showDispatch);
  if (showDispatch) {
    const d = snap.directive;
    const key = `${d.title}|${(d.options || []).map(o => o.id).join(',')}`;
    if (key !== lastDirectiveKey) {
      lastDirectiveKey = key;
      const set = (id, v) => { const el = $(id); if (el) el.textContent = v == null ? '' : String(v); };
      set('dispatchTitle', d.title);
      set('dispatchBody', d.body);
      const opts = Array.isArray(d.options) ? d.options : [];
      const a = opts[0] || {};
      const b = opts[1] || {};
      set('dispatchChoiceALabel', a.label); set('dispatchChoiceADesc', a.desc || a.sub);
      set('dispatchChoiceBLabel', b.label); set('dispatchChoiceBDesc', b.desc || b.sub);
      const btnA = $('dispatchChoiceA'); if (btnA) btnA.dataset.optionId = a.id || 'a';
      const btnB = $('dispatchChoiceB'); if (btnB) btnB.dataset.optionId = b.id || 'b';
    }
  } else {
    lastDirectiveKey = '';
  }
  // REPORT -> #reportScreen
  const showReport = phase === 'report';
  setScreenVisible('reportScreen', showReport);
  if (showReport) {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = Number(v || 0).toLocaleString(); };
    set('reportCasesPrevented', snap.casesPrevented);
    set('reportSwatted', snap.swatted);
    set('reportCleanMonths', snap.cleanMonths);
    const rt = $('reportTitle');
    if (rt) rt.textContent = snap.monthName || snap.monthLabel || t('hud.phase.triage');
  }
  // PERK -> #perkScreen
  const showPerk = phase === 'perk';
  setScreenVisible('perkScreen', showPerk);
  if (showPerk) {
    const choices = Array.isArray(snap.perkChoices) ? snap.perkChoices : [];
    const key = choices.map(p => p.id).join(',');
    if (key !== lastPerkKey) {
      lastPerkKey = key;
      const grid = $('perkGrid');
      if (grid) {
        grid.textContent = '';
        choices.forEach((p, i) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'perk-card';
          btn.setAttribute('data-perk-id', p.id);
          const keyEl = document.createElement('span');
          keyEl.className = 'choice-key';
          const kbd = document.createElement('kbd');
          kbd.className = 'kbd';
          kbd.textContent = String(i + 1);
          keyEl.appendChild(kbd);
          const name = document.createElement('span');
          name.className = 'perk-name';
          name.textContent = p.name || p.id;
          const desc = document.createElement('span');
          desc.className = 'perk-desc';
          desc.textContent = p.desc || '';
          btn.append(keyEl, name, desc);
          grid.appendChild(btn);
        });
      }
    }
  } else {
    lastPerkKey = '';
  }
}

/* ---------------- Pointer dispatch (map coordinates) ---------------- */
function mapPoint(ev) {
  const canvas = $('canvas');
  const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
  const [mx, my] = toMap((ev.clientX || 0) - rect.left, (ev.clientY || 0) - rect.top);
  return { x: mx, y: my, mapX: mx, mapY: my };
}
function forwardPointer(kind, ev) {
  if (!currentMode) return;
  const fn = currentMode[kind];
  if (typeof fn !== 'function') return;
  try { fn.call(currentMode, mapPoint(ev), ev); } catch (e) { console.error('[main] pointer handler failed', e); }
}

/* ---------------- Keyboard dispatch + global shortcuts ---------------- */
function forwardToMode(ev) {
  if (!currentMode || typeof currentMode.onKeyDown !== 'function') return;
  try { currentMode.onKeyDown(ev); } catch (e) { console.error('[main] key handler failed', e); }
}
function onKeyDown(ev) {
  const target = ev.target;
  const tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable);
  const key = ev.key;
  if (typing) { if (key === 'Escape' && target && target.blur) target.blur(); return; }
  const lower = typeof key === 'string' ? key.toLowerCase() : '';
  const mod = ev.ctrlKey || ev.metaKey || ev.altKey;
  if (lower === 'l' && !mod) {
    ev.preventDefault();
    toggleLang();
    return;
  }
  if (key === 'Tab') {
    ev.preventDefault();
    togglePanel();
    return;
  }
  if (key === 'Escape') {
    if (isEpikdOpen()) { ev.preventDefault(); setEpikdOpen(false); return; }
    const lb = $('leaderboardScreen');
    if (lb && !lb.hidden) { ev.preventDefault(); hideScreen('leaderboardScreen'); if (typeof closeLeaderboard === 'function') closeLeaderboard(); return; }
    if (canPause()) { ev.preventDefault(); togglePause(); forwardToMode(ev); return; }
    return;
  }
  if (lower === 'p' && !mod && canPause()) {
    ev.preventDefault();
    togglePause();
    forwardToMode(ev);
    return;
  }
  if (key === ' ') {
    ev.preventDefault();
    if (paused) { setPaused(false); return; }
    forwardToMode(ev);
    return;
  }
  forwardToMode(ev);   // 1-6 district select, Enter confirm, Tab-adjacent keys, etc.
}
function toggleLang() {
  toggleLanguage();
  applyStaticI18n();
  updateLangButtons();
  renderMutators();
  refreshHubBests();
  refreshHud();
}
function updateLangButtons() {
  const lang = getLang();
  const en = $('langEnBtn');
  const id = $('langIdBtn');
  if (en) { en.setAttribute('aria-pressed', String(lang === 'en')); en.classList.toggle('is-active', lang === 'en'); }
  if (id) { id.setAttribute('aria-pressed', String(lang === 'id')); id.classList.toggle('is-active', lang === 'id'); }
}
function togglePanel() {
  if (uiHud && typeof uiHud.togglePanel === 'function') {
    try { uiHud.togglePanel(); return; } catch (e) { /* fall through to class toggle */ }
  }
  panelCollapsed = !panelCollapsed;
  const panel = $('panel');
  if (panel) panel.classList.toggle('hidden', panelCollapsed);
}

/* ---------------- RAF loop ---------------- */
function frame(now) {
  requestAnimationFrame(frame);
  const dt = lastFrame ? Math.min(0.1, Math.max(0, (now - lastFrame) / 1000)) : 0;
  lastFrame = now;
  if (!cachedCtx) {
    const canvas = $('canvas');
    cachedCtx = canvas ? canvas.getContext('2d') : null;
  }
  const ctx = cachedCtx;
  const snap = currentMode ? safeSnapshot() : null;
  if (currentMode) {
    if (!paused) {
      try { currentMode.update(dt, now); } catch (e) { console.error('[main] update failed', e); }
    }
    document.body.classList.toggle('phase-wave', !!snap && snap.phase === 'wave');
    if (ctx && typeof currentMode.render === 'function') {
      try { currentMode.render(ctx, getView(), now); } catch (e) { console.error('[main] render failed', e); }
    }
  } else if (ctx && renderer) {
    try { renderer.render(ctx, {}, now); } catch (e) { console.error('[main] background render failed', e); }
    document.body.classList.remove('phase-wave');
  }
  hudTimer += dt;
  if (hudTimer >= 0.2) {
    hudTimer = 0;
    refreshHud(snap);
    syncPhaseScreens(snap);
    syncTerminalState(snap);
  }
}

/* ---------------- Leaderboard submission from #endScreen ---------------- */
function submitEndOfRun() {
  const G = getG();
  const score = G && Number.isFinite(G.score) ? Math.round(G.score) : (window.LB_PENDING_SCORE || 0);
  const modeId = (G && G.mode) || currentModeId || 'operations';
  if (typeof submitScore !== 'function') {
    showToast(t('lb.offline'), true);
    return;
  }
  const name = String(storageGet('dd_lb_name') || '').trim() || 'SATGAS-1';
  Promise.resolve()
    .then(() => submitScore({
      name,
      score,
      mode: modeId,
      doctrine: G && G.doctrine,
      scenario: G && G.scenario,
      seed: G && (G.seedStr != null ? G.seedStr : G.seed),
      mutators: G && G.mutators,
      months: G && Array.isArray(G.months) ? G.months.length : undefined,
    }))
    .then((result) => {
      if (result && result.ok === true) {
        showToast(t('lb.submit.success', { count: result.rank || 0 }));
      } else {
        showToast(t('lb.offline'), true);
      }
    })
    .catch(() => showToast(t('lb.offline'), true));
}

/* ---------------- Wiring ---------------- */
function wireDom() {
  const canvas = $('canvas');
  if (canvas) {
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    canvas.addEventListener('pointerdown', (ev) => {
      if (!currentMode) return;
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      forwardPointer('onPointerDown', ev);
    });
    canvas.addEventListener('pointermove', (ev) => forwardPointer('onPointerMove', ev));
    canvas.addEventListener('pointerup', (ev) => forwardPointer('onPointerUp', ev));
    canvas.addEventListener('pointercancel', (ev) => forwardPointer('onPointerUp', ev));
  }
  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('resize', () => { if (renderer) renderer.resize(); }, { passive: true });

  // HUD cluster
  $('hudPauseBtn')?.addEventListener('click', togglePause);
  $('langEnBtn')?.addEventListener('click', () => { if (getLang() !== 'en') toggleLang(); });
  $('langIdBtn')?.addEventListener('click', () => { if (getLang() !== 'id') toggleLang(); });
  $('hudAudioBtn')?.addEventListener('click', () => syncAudioButton(!isAudioEnabled()));
  $('hudHapticsBtn')?.addEventListener('click', () => syncHapticsButton(!isHapticsEnabled()));
  $('hudEpikdBtn')?.addEventListener('click', () => setEpikdOpen(!isEpikdOpen()));
  $('hubEpikdBtn')?.addEventListener('click', () => setEpikdOpen(!isEpikdOpen()));
  $('epikdCloseBtn')?.addEventListener('click', () => setEpikdOpen(false));
  document.querySelectorAll('.drawer-tab').forEach((tab) => {
    tab.addEventListener('click', () => activateEpikdTab(tab.getAttribute('data-epikd-tab')));
  });

  // Mode router (hub)
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.addEventListener('click', () => { selectedMode = card.getAttribute('data-mode') || 'operations'; paintModeCards(); });
  });
  document.querySelectorAll('.doctrine-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-doctrine');
      selectedDoctrine = selectedDoctrine === id ? null : id;
      paintDoctrineCards();
    });
  });
  $('hubSeedRandom')?.addEventListener('click', () => { const input = $('hubSeedInput'); if (input) input.value = randomSeedWord(); seedLock = ''; });
  $('hubSeedApply')?.addEventListener('click', () => {
    const input = $('hubSeedInput');
    seedLock = String((input && input.value) || '').trim();
    showToast(seedLock ? seedLock.toUpperCase() : t('hub.seed.random'));
  });
  $('hubDeployBtn')?.addEventListener('click', () => startMode(selectedMode, {}));
  $('hubLeaderboardBtn')?.addEventListener('click', () => {
    showScreen('leaderboardScreen');
    if (typeof openLeaderboard === 'function') openLeaderboard(currentModeId || selectedMode);
  });

  // Tactical rail
  $('panelHandle')?.addEventListener('click', togglePanel);
  $('panelCommitBtn')?.addEventListener('click', () => {
    if (currentModeId === 'crisis_board') {
      forwardToMode({ key: 'Enter', preventDefault() {} });
    } else {
      dispatchDd('dd:commit-deployment', {});
    }
  });

  // Directive screen (mode1 choices)
  $('dispatchChoiceA')?.addEventListener('click', (ev) => {
    dispatchDd('dd:directive-choice', { optionId: ev.currentTarget.dataset.optionId || 'a' });
    hideScreen('dispatchScreen');
  });
  $('dispatchChoiceB')?.addEventListener('click', (ev) => {
    dispatchDd('dd:directive-choice', { optionId: ev.currentTarget.dataset.optionId || 'b' });
    hideScreen('dispatchScreen');
  });
  $('reportContinueBtn')?.addEventListener('click', () => {
    dispatchDd('dd:report-continue', {});
    hideScreen('reportScreen');
  });
  $('perkGrid')?.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-perk-id]') : null;
    if (!btn) return;
    dispatchDd('dd:perk-pick', { perkId: btn.getAttribute('data-perk-id') });
    hideScreen('perkScreen');
  });

  // Pause / badge screens
  $('pauseResumeBtn')?.addEventListener('click', () => setPaused(false));
  $('pauseHubBtn')?.addEventListener('click', () => { setPaused(false); exitToHub(); });
  $('badgeCloseBtn')?.addEventListener('click', () => hideScreen('badgeScreen'));

  // Leaderboard screen
  $('lbCloseBtn')?.addEventListener('click', () => { hideScreen('leaderboardScreen'); if (typeof closeLeaderboard === 'function') closeLeaderboard(); });
  $('lbRefreshBtn')?.addEventListener('click', () => { if (typeof openLeaderboard === 'function') openLeaderboard(currentModeId || selectedMode); });
  $('lbSubmitForm')?.addEventListener('submit', (ev) => ev.preventDefault());

  // End screen
  $('endSubmitBtn')?.addEventListener('click', submitEndOfRun);
  $('endPlayAgainBtn')?.addEventListener('click', () => {
    const G = getG();
    startMode(currentModeId || (G && G.mode) || 'operations', { seedStr: (G && G.seedStr) || undefined });
  });
  $('endNewSeedBtn')?.addEventListener('click', () => startMode(currentModeId || 'operations', { seedStr: randomSeedWord() }));
  $('endHubBtn')?.addEventListener('click', exitToHub);

  // Sibling modals -> shell events (inert when sibling is absent)
  window.addEventListener('dd:hub-start', (ev) => {
    const d = (ev && ev.detail) || {};
    startMode(d.mode || 'operations', {
      seedStr: d.seedStr,
      doctrine: d.doctrine,
      scenario: d.scenario,
      mutators: d.mutators,
    });
  });
  window.addEventListener('dd:replay-same-seed', (ev) => {
    const d = (ev && ev.detail) || {};
    const G = getG();
    startMode(d.mode || currentModeId || 'operations', { seedStr: d.seedStr || (G && G.seedStr) || undefined });
  });
  window.addEventListener('dd:replay-new-seed', (ev) => {
    const d = (ev && ev.detail) || {};
    startMode(d.mode || currentModeId || 'operations', { seedStr: randomSeedWord() });
  });
  window.addEventListener('dd:return-hub', () => exitToHub());
  window.addEventListener('dd:restart', () => {
    const G = getG();
    startMode(currentModeId || 'operations', { seedStr: (G && G.seedStr) || undefined });
  });
  window.addEventListener('dd:abandon', () => exitToHub());

  // Mode -> shell events
  window.addEventListener('dd:gameover', (ev) => gameOver(ev && ev.detail && ev.detail.reason));
  window.addEventListener('dd:open-epikd-audit', () => setEpikdOpen(true, 'epikdPanelAudit'));
}

function syncAudioButton(enabled) {
  setAudioEnabled(enabled);
  const btn = $('hudAudioBtn');
  if (btn) {
    btn.setAttribute('aria-pressed', String(!!enabled));
    btn.classList.toggle('is-active', !!enabled);
  }
}
function syncHapticsButton(enabled) {
  setHapticsEnabled(enabled);
  const btn = $('hudHapticsBtn');
  if (btn) {
    btn.setAttribute('aria-pressed', String(!!enabled));
    btn.classList.toggle('is-active', !!enabled);
  }
}

/* ---------------- Optional sibling modules (guarded) ---------------- */
async function loadSiblings() {
  try { uiHud = await import('./ui/hud.js'); } catch (e) { uiHud = null; }
  try { uiModals = await import('./ui/modals.js'); } catch (e) { uiModals = null; }
  try { epikdLab = await import('./ui/epikd-lab.js'); } catch (e) { epikdLab = null; }
  bindSiblings();
}
function bindSiblings() {
  if (uiHud && typeof uiHud.bindHudControls === 'function') {
    try {
      uiHud.bindHudControls({
        onPause: () => { togglePause(); return true; },
        onCommit: (mode) => {
          if (mode === 'crisis_board') forwardToMode({ key: 'Enter', preventDefault() {} });
          else dispatchDd('dd:commit-deployment', {});
          return true;
        },
        onSpray: () => { dispatchDd('dd:spray-burst', {}); return true; },
        onSurgeWard: () => { dispatchDd('dd:surge-ward', {}); return true; },
        onEpikd: () => { setEpikdOpen(!isEpikdOpen()); return true; },
        onLanguage: () => true,   // hud re-renders itself via dd:langchange
        onAudioToggle: () => true,
        onHapticsToggle: () => true,
        onTogglePanel: () => true,
        onCopySeed: () => true,
        onDistrictSelect: (districtId) => { dispatchDd('dd:select-district', { districtId }); return undefined; },
        onProtocolToggle: (protocol, districtId, active) => { dispatchDd('dd:toggle-protocol', { protocol, districtId, active }); return undefined; },
        onActionSelect: (actionId) => {
          try {
            const snap = safeSnapshot();
            const act = snap && Array.isArray(snap.actions) ? snap.actions.find(a => a && a.id === actionId) : null;
            if (act && act.key) { forwardToMode({ key: act.key, preventDefault() {} }); return true; }
          } catch (e) { console.error('[main] action select failed', e); }
          dispatchDd('dd:select-action', { actionId });
          return true;
        },
        onPing: (districtId) => { dispatchDd('dd:ping', { districtId }); return undefined; },
      });
    } catch (e) { console.error('[main] bindHudControls failed', e); }
  }
  if (uiModals && typeof uiModals.showHub === 'function' && !currentModeId) {
    try {
      uiModals.showHub({
        mode: selectedMode,
        doctrine: selectedDoctrine || 'surveillance_directorate',
        mutators: [...selectedMutators],
        bestScores: {
          operations: loadBest('operations'),
          crisis_board: loadBest('crisis_board'),
          blitz: loadBest('blitz'),
        },
      });
    } catch (e) { console.error('[main] showHub failed', e); }
  }
}

/* ---------------- Global hooks ---------------- */
function installGlobalHooks() {
  window.gameOver = (reason) => gameOver(reason);
  try { window.LB_API = LB_API; } catch (e) { /* ignore */ }
  window.DD = Object.freeze({
    startMode,
    exitToHub,
    showToast,
    showBanner,
    getMode: () => currentModeId,
    getView,
    version: 'field-edition-1.0.0',
  });
}

/* ---------------- Boot ---------------- */
function boot() {
  applyStaticI18n();
  updateLangButtons();
  // Seed placeholder from pack (kept off data-i18n so applyStaticI18n stays text-only)
  const seedInput = $('hubSeedInput');
  if (seedInput) seedInput.setAttribute('placeholder', t('hub.seed.placeholder'));
  // Canvas + renderer
  const canvas = $('canvas');
  if (canvas) {
    renderer = new MapRenderer(canvas);
    renderer.enableAutoResize();
    renderer.resize();
  }
  wireDom();
  installGlobalHooks();
  // Mirror G/W onto window even before the first mode boots (E2E hooks).
  try { if (typeof window.G === 'undefined') setG(getG()); } catch (e) { /* ignore */ }
  try { if (typeof window.W === 'undefined') setW(getW()); } catch (e) { /* ignore */ }
  // Reflect initial toggle states
  syncAudioButton(isAudioEnabled());
  syncHapticsButton(isHapticsEnabled());
  paintModeCards();
  paintDoctrineCards();
  renderMutators();
  refreshHubBests();
  showOnly('hubScreen');
  refreshHud(null);
  // Quick boot via ?mode=
  if (paramMode) startMode(paramMode, {});
  requestAnimationFrame(frame);
  void loadSiblings().then(() => refreshHud());
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
