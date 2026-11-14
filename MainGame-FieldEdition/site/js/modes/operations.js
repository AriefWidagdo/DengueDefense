/* ============================================================
   Dengue Defense — Field Edition · Mode 1: Monsoon Operations
   Hybrid tactical plan + reflex wave campaign (spec 04).
   ES module. Zero emojis. No scientific disclaimers (those live
   in js/ui/epikd-lab.js). Map coordinates are the virtual 700x500
   corridor; letterboxing is owned by js/map-renderer.js.

   Phase flow: BRIEFING -> PLAN -> WAVE -> REPORT -> PERK -> next month
   Exports the Mode Adapter Contract:
     OperationsMode { id, supportsPause, usesRealTimeCanvasLoop,
       init, dispose, update, render,
       onPointerDown, onPointerMove, onPointerUp, onKeyDown, getHudSnapshot }

   HUD wiring (js/ui/hud.js renders from getHudSnapshot()):
     - BRIEFING choice buttons read snapshot.directive.options and
       dispatch  CustomEvent('dd:directive-choice', { detail: { optionId } })
       (or call nothing — the 10s failure mode auto-advances with no effect).
     - PLAN commit button dispatches 'dd:commit-deployment' (alias
       'dd:commit-plan') or the player presses Enter.
     - WAVE spray button dispatches 'dd:spray-burst' (alias: Space key or
       right-click on the canvas). Surge Ward dispatches 'dd:surge-ward'
       (or key 'w') when funds >= 3.
     - REPORT continue dispatches 'dd:report-continue' (or Enter/Space).
       The optional audit pill dispatches 'dd:open-epikd-audit' (HUD renders
       the pill from snapshot.report.auditPillLabel; the mode also dispatches
       the same event on key 'a' as a keyboard affordance).
     - PERK pick dispatches 'dd:perk-pick' { detail: { perkId } } or keys 1-3.
     - Plan-phase shock reveals dispatch 'dd:shock-revealed' { shockId, type }.
     - Hospital overflow calls the shell's window.gameOver('hospital') when
       present; otherwise the mode installs a sensible default on window,
       dispatches 'dd:gameover' and marks phase 'end'.
   ============================================================ */

import {
  GAME_RULES, MONTHS, DOCTRINES, SCENARIOS, PROTOCOLS, PERKS,
  freshState, mulberry32, parseSeed, scoreMult, hasMut,
  getG, setG, getW, setW,
} from '../state.js';
import { t, getLang } from '../i18n.js';
import {
  RIVERS, districtAt, riskOf, EpiRuntime,
} from '../epi-engine.js';
import { FX, getView, toMap, CORRIDOR } from '../map-renderer.js';
import {
  drawMapBackground, drawMerapiContour, drawRiverCurves, drawDistrictPolygon,
  drawUnitMarker, drawStandingPool, drawMosquitoSprite, drawSlashTrail,
  drawSprayBurst, drawHotspotNode,
} from '../sprites.js';
import { SFX, vibrate } from '../audio.js';

/* =====================================================================
   Local helpers
   ===================================================================== */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / lenSq, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/* Cubic bezier sampler used to anchor Monsoon Flanker spawns to the two
   hydro corridors (paths mirror epi-engine RIVER data). */
function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}
const RIVER_POLYS = (() => {
  const segs = [
    [[430, 210], [445, 180], [465, 165], [510, 130]],
    [[510, 130], [555, 95], [610, 75], [680, 55]],
    [[218, 125], [210, 195], [190, 260], [155, 345]],
  ];
  const pts = [];
  for (const [p0, p1, p2, p3] of segs) {
    for (let i = 0; i <= 8; i++) pts.push(cubic(p0, p1, p2, p3, i / 8));
  }
  return pts;
})();

/* Mirror of the engine climate overlays (engine does not export them). */
const CLIMATE = Object.freeze({
  baseline:       Object.freeze({ pressure: 1.00, mu: 1.00 }),
  monsoon_surge:  Object.freeze({ pressure: 1.22, mu: 1.18 }),
  urban_commuter: Object.freeze({ pressure: 1.15, mu: 1.12 }),
  el_nino_drought:Object.freeze({ pressure: 0.85, mu: 0.88 }),
});
const climateOf = p => CLIMATE[p] || CLIMATE.baseline;

const CORRIDOR_HOTSPOTS = ['sleman', 'klaten', 'surakarta'];   // commuter_corridor
const HIGHLAND_HOTSPOTS = ['boyolali', 'sleman', 'klaten'];    // merapi_ashfall
const RIPARIAN_HOTSPOTS = ['surakarta', 'sukoharjo', 'klaten'];// bengawan_flood

const RISK_IDS = ['SAFE', 'ELEVATED', 'HIGH', 'CRITICAL'];
const ESCAPE_BED_WEIGHT = 1;      // ICU bed pressure per standard escape
const VIREMIC_BED_WEIGHT = 2;     // Viremic Vector: 2x ICU damage
const QUEEN_BED_WEIGHT = 2;
const SURGE_WARD_COST = 3;
const SURGE_WARD_RELIEF = 25;
const SPRAY_RADIUS_PX = 110;      // base AoE radius (CSS px on screen)
const BRIEFING_SECONDS = 10;
const SHOCK_REVEAL_TIMES = [2.0, 4.0];
const PING_BASE_COST = 3;

/* 6 directive templates (spec 04 Phase A). Effects are mechanical and
   asymmetric. resolveDirective(choiceId) applies them. */
const DIRECTIVE_DECK = [
  {
    id: 'el_nino', title: 'El Nino Early Rains',
    body: 'Models converge on an early onset. The basin will flood before the drainage crews mobilize.',
    options: [
      { id: 'a', label: 'Emergency Drain Subsidy', sub: '+4 funds, -15% standing water next wave' },
      { id: 'b', label: 'Reserve ICU Tents', sub: '+60 surge beds permanently, -2 funds' },
    ],
  },
  {
    id: 'kader', title: 'Kader Mobilization',
    body: 'Village health volunteers report for duty. How do you deploy the network this month?',
    options: [
      { id: 'a', label: 'Neighborhood 3M Sweep', sub: 'PSN is free in 1 district this month' },
      { id: 'b', label: 'Laboratory Sequencing', sub: 'Surveillance Ping reveals all 6 districts for 2 months' },
    ],
  },
  {
    id: 'transit', title: 'Peak Holiday Transit',
    body: 'Rail and bus corridors are at capacity. Fever cases ride the Solo-Yogya line.',
    options: [
      { id: 'a', label: 'Station Fever Screening', sub: '-25% Sleman / Surakarta commuter spillover this month' },
      { id: 'b', label: 'Mobile Clinic Convoy', sub: '+40 beds, +3 funds' },
    ],
  },
  {
    id: 'shortage', title: 'Fogging Chemical Shortage',
    body: 'The regional depot is dry. ULV fog drums are rationed until the resupply convoy arrives.',
    options: [
      { id: 'a', label: 'Prioritize Bio-Ovitraps', sub: 'Traps +20% effective for 2 months; Fog costs +2 for 2 months' },
      { id: 'b', label: 'Emergency Stockpile Airlift', sub: '-4 funds; Fog unlimited and +1 radius for 2 months' },
    ],
  },
  {
    id: 'overload', title: 'Hospital Overload Alert',
    body: 'Regional wards are past safe occupancy. The health office wants a decision now.',
    options: [
      { id: 'a', label: 'Divert Regional Wards', sub: '+120 temporary beds this wave; -10% score multiplier' },
      { id: 'b', label: 'Strict Community Quarantine', sub: '-20% spawn rate; +1 bite severity if vectors escape' },
    ],
  },
  {
    id: 'late_monsoon', title: 'Late-Monsoon Containment',
    body: 'The rains are breaking. One decisive push could end the season — or a watchful grid could.',
    options: [
      { id: 'a', label: 'All-Out Eradication Push', sub: '+6 funds; vector speed +15% this wave' },
      { id: 'b', label: 'Long-Tail Surveillance', sub: 'Reveal all shocks now; steady recovery -30 ICU load' },
    ],
  },
];

const DIRECTIVE_I18N_NUM = Object.freeze({
  el_nino: '1',
  kader: '2',
  transit: '3',
  shortage: '4',
  overload: '5',
  late_monsoon: '6',
});

function trOr(key, fallback) {
  const val = t(key);
  return val && val !== key ? val : fallback;
}

/** Resolve directive title, body, and choice copy for the active locale. */
function localizeDirective(d) {
  if (!d) return null;
  const num = DIRECTIVE_I18N_NUM[d.id];
  const prefix = num ? `mode1.directive.${num}` : '';
  return {
    ...d,
    title: prefix ? trOr(`${prefix}.title`, d.title) : d.title,
    body: prefix ? trOr(`${prefix}.body`, d.body) : d.body,
    options: (d.options || []).map(o => ({
      ...o,
      label: prefix ? trOr(`${prefix}.${o.id}.label`, o.label) : o.label,
      sub: prefix ? trOr(`${prefix}.${o.id}.desc`, o.sub) : o.sub,
    })),
  };
}

const SHOCK_TYPES = Object.freeze([
  { type: 'rain_spike',             mult: 1.30, delayed: 0,  pools: +2, label: 'Rain Spike' },
  { type: 'reporting_lag',          mult: 1.10, delayed: +8, pools: 0,  label: 'Reporting Lag' },
  { type: 'transit_cluster',        mult: 1.25, delayed: 0,  pools: 0,  label: 'Transit Cluster' },
  { type: 'forecast_revision_down', mult: 0.80, delayed: 0,  pools: 0,  label: 'Forecast Revision Down' },
  { type: 'community_drain',        mult: 0.90, delayed: 0,  pools: -3, label: 'Community Drain' },
  { type: 'larvae_bloom',           mult: 1.15, delayed: 0,  pools: +3, label: 'Larvae Bloom' },
]);

/* =====================================================================
   Module-scope run state (single active Operations run per page)
   ===================================================================== */
const listener = { attached: false };

const S = {
  active: false,
  phase: 'idle',            // briefing | plan | wave | report | perk | end
  paused: false,
  seedStr: 'MONSOON-ALPHA-001',
  seed: 1,
  doctrine: null,
  scenario: 'solo_basin',
  scenarioDef: null,
  months: [],               // array of MONTHS entries used by this run
  rng: Math.random,
  waveRng: Math.random,
  fx: null,
  // timing
  briefingT: 0,
  planT: 0,
  waveElapsed: 0,
  // campaign bookkeeping
  monthIndex: 0,
  hospitalCapBonus: 0,
  tempCapacity: 0,
  pressure: 0,              // fever pressure accumulator for the live wave
  scorePenaltyMult: 1,
  peakHeadroom: 0,
  cleanMonths: 0,
  casesPrevented: 0,
  swatted: 0,
  poolsDrained: 0,
  // directives / shocks
  directive: null,
  directiveResolved: false,
  shocks: [],
  revealTimes: [...SHOCK_REVEAL_TIMES],
  waveMods: {},             // per-wave modifiers (reset each month)
  campaignMods: {},         // multi-month modifiers
  // selection / interaction
  selectedId: null,
  pointerActive: false,
  trail: [],
  lastPt: null,
  // wave entities
  mosq: [],
  queue: [],
  pools: [],
  standingPools: [],
  traps: [],
  fogT: {},
  fogInterval: 3,
  friendlies: [],
  sprayBursts: [],
  slashes: [],
  combo: 0,
  comboT: 0,
  comboWindow: 1.8,
  maxCombo: 0,
  sprayCharge: 0,
  waveDuration: 24,
  waveTimeLeft: 0,
  waveTotal: 0,
  waveSpawned: 0,
  bites: 0,
  surgeUsed: false,
  // report / perk
  report: null,
  perkChoices: [],
  result: null,             // 'victory' | 'hospital' | null
  // audio/fx throttle
  buzzTimer: 0,
};

function resetRunState() {
  S.active = false; S.phase = 'idle'; S.paused = false;
  S.fx = null; S.briefingT = 0; S.planT = 0; S.waveElapsed = 0;
  S.monthIndex = 0; S.hospitalCapBonus = 0; S.tempCapacity = 0; S.pressure = 0;
  S.scorePenaltyMult = 1; S.peakHeadroom = 0; S.cleanMonths = 0;
  S.casesPrevented = 0; S.swatted = 0; S.poolsDrained = 0;
  S.directive = null; S.directiveResolved = false;
  S.shocks = []; S.revealTimes = [...SHOCK_REVEAL_TIMES];
  S.waveMods = {}; S.campaignMods = {};
  S.selectedId = null; S.pointerActive = false; S.trail = []; S.lastPt = null;
  S.mosq = []; S.queue = []; S.pools = []; S.standingPools = [];
  S.traps = []; S.fogT = {}; S.fogInterval = 3; S.friendlies = [];
  S.sprayBursts = []; S.slashes = [];
  S.combo = 0; S.comboT = 0; S.comboWindow = 1.8; S.maxCombo = 0;
  S.sprayCharge = 0; S.waveDuration = 24; S.waveTimeLeft = 0;
  S.waveTotal = 0; S.waveSpawned = 0; S.bites = 0; S.surgeUsed = false;
  S.report = null; S.perkChoices = []; S.result = null; S.buzzTimer = 0;
}

const isBrowser = () => typeof window !== 'undefined';
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function dispatch(name, detail) {
  if (!isBrowser()) return false;
  try {
    const Ctor = typeof window.CustomEvent === 'function' ? window.CustomEvent : null;
    const ev = Ctor ? new Ctor(name, { detail }) : null;
    if (ev) window.dispatchEvent(ev);
    return true;
  } catch (e) { return false; }
}

function listen(name, fn) {
  if (!isBrowser() || typeof window.addEventListener !== 'function') return;
  window.addEventListener(name, fn);
}
function unlisten(name, fn) {
  if (!isBrowser() || typeof window.removeEventListener !== 'function') return;
  window.removeEventListener(name, fn);
}

/* Hospital overflow hook. Tests drive window.gameOver('hospital'). If the
   shell provided one, delegate to it. Otherwise install a sensible default
   and notify listeners via 'dd:gameover'. */
function callGameOver(reason) {
  if (isBrowser() && typeof window.gameOver === 'function') {
    try { window.gameOver(reason); return; } catch (e) { /* fall through to default */ }
  }
  if (isBrowser()) {
    if (typeof window.gameOver !== 'function') {
      window.gameOver = (r) => {
        const G = getG();
        if (G) { G.phase = 'end'; G.result = r || 'hospital'; setG(G); }
        S.phase = 'end'; S.result = r || 'hospital'; S.active = false;
        try { SFX.stopBuzz(); SFX.stopMusic(); SFX.play('lose'); } catch (e) { /* audio optional */ }
      };
    }
    dispatch('dd:gameover', { reason });
    try { window.gameOver(reason); } catch (e) { /* default must not throw */ }
  } else {
    S.phase = 'end'; S.result = reason;
  }
}

/* Apply doctrine-modified rule lookups */
function doctrineDef() { return DOCTRINES.find(d => d.id === S.doctrine) || null; }
function pingCost() {
  const def = doctrineDef();
  if (def && def.mods && def.mods.pingCostFactor != null) {
    return Math.max(def.mods.pingMinCost || 2, Math.floor(PING_BASE_COST * def.mods.pingCostFactor));
  }
  return PING_BASE_COST;
}
function psnFactor() {
  const def = doctrineDef();
  return (def && def.mods && def.mods.psnFactor) || GAME_RULES.psnFactor;
}
function drainFactor() {
  const def = doctrineDef();
  return (def && def.mods && def.mods.drainFactor) || GAME_RULES.drainFactor;
}
function poolStep() {
  const def = doctrineDef();
  return (def && def.mods && def.mods.poolStep) || GAME_RULES.poolStep;
}
function swatRadius() {
  const def = doctrineDef();
  const base = 34 * (hasG('racket') ? 1.4 : 1);
  return base * ((def && def.mods && def.mods.swatRadiusFactor) || 1);
}
function sprayChargeFactor() {
  const def = doctrineDef();
  let f = (def && def.mods && def.mods.sprayChargeFactor) || 1;
  if (hasG('combo')) f *= 1.3;
  return f;
}
function sprayRadiusMap() {
  const def = doctrineDef();
  const view = getView();
  const px = SPRAY_RADIUS_PX * ((def && def.mods && def.mods.swatRadiusFactor) || 1);
  const scale = view && view.scale ? view.scale : 1;
  return px / Math.max(0.25, scale); // convert CSS px radius to map units
}
function clinicSlots() {
  const G = getG();
  const def = doctrineDef();
  return (def && def.mods && def.mods.clinicSlots) || (G && G.clinicSlots) || GAME_RULES.clinicSlots;
}
function hasG(perkId) {
  const G = getG();
  return !!(G && G.perks && G.perks[perkId]);
}
function perkCount(perkId) {
  const G = getG();
  return (G && G.perks && G.perks[perkId]) || 0;
}
function hospitalCap() {
  const G = getG();
  const base = (G && G.hospitalCap) || GAME_RULES.careSlots;
  return base + S.hospitalCapBonus + S.tempCapacity + activeClinicCount() * clinicSlots();
}
function activeClinicCount() {
  const G = getG();
  if (!G || !Array.isArray(G.districts)) return 0;
  return G.districts.filter(d => d.proto && d.proto.clinic).length;
}
function addFunds(n) {
  const G = getG(); if (!G) return;
  G.budget = Math.max(0, Math.round(G.budget + n));
  setG(G);
}
function spendFunds(n) {
  const G = getG(); if (!G) return false;
  if (G.budget < n) return false;
  G.budget = Math.round(G.budget - n);
  setG(G);
  return true;
}
function scenarioLengthFactor(len) {
  if (len >= 6) return 1.0;
  if (len === 5) return 0.925;
  return 0.85;
}
function computeScore() {
  const G = getG();
  const base = S.casesPrevented * 120 + S.swatted * 25 + S.poolsDrained * 90
    + S.peakHeadroom * 15 + S.cleanMonths * 400;
  const score = Math.max(0, Math.round(
    base * scoreMult() * S.scorePenaltyMult * scenarioLengthFactor(S.months.length || 6)
  ));
  if (G) { G.score = score; setG(G); }
  return score;
}

/* =====================================================================
   Event wiring (registered in init, removed in dispose)
   ===================================================================== */
function onDirectiveChoiceEvent(ev) {
  const detail = (ev && ev.detail) || {};
  const optionId = detail.optionId || detail.id || detail.choice || null;
  if (S.phase === 'briefing' && !S.directiveResolved) resolveDirective(optionId);
}
function onCommitEvent() { if (S.phase === 'plan') commitDeployment(); }
function onSprayEvent() { if (S.phase === 'wave') triggerSprayBurst(S.lastPt); }
function onSurgeWardEvent() { if (S.phase === 'wave') buySurgeWard(); }
function onReportContinueEvent() { if (S.phase === 'report') continueFromReport(); }
function onPerkPickEvent(ev) {
  const detail = (ev && ev.detail) || {};
  const perkId = detail.perkId || detail.id || null;
  if (S.phase === 'perk') choosePerk(perkId);
}
function registerListeners() {
  if (listener.attached) return;
  listen('dd:directive-choice', onDirectiveChoiceEvent);
  listen('dd:commit-deployment', onCommitEvent);
  listen('dd:commit-plan', onCommitEvent);
  listen('dd:spray-burst', onSprayEvent);
  listen('dd:surge-ward', onSurgeWardEvent);
  listen('dd:report-continue', onReportContinueEvent);
  listen('dd:perk-pick', onPerkPickEvent);
  listener.attached = true;
}
function unregisterListeners() {
  if (!listener.attached) return;
  unlisten('dd:directive-choice', onDirectiveChoiceEvent);
  unlisten('dd:commit-deployment', onCommitEvent);
  unlisten('dd:commit-plan', onCommitEvent);
  unlisten('dd:spray-burst', onSprayEvent);
  unlisten('dd:surge-ward', onSurgeWardEvent);
  unlisten('dd:report-continue', onReportContinueEvent);
  unlisten('dd:perk-pick', onPerkPickEvent);
  listener.attached = false;
}

/* =====================================================================
   Run setup
   ===================================================================== */
function resolveScenario(id) {
  return SCENARIOS.find(s => s.id === id) || SCENARIOS[0];
}
function monthsForScenario(scen) {
  const [a, b] = scen.monthRange || [0, 5];
  return MONTHS.slice(a, b + 1);
}
function absoluteMonthIndex() {
  const a = (S.scenarioDef && S.scenarioDef.monthRange && S.scenarioDef.monthRange[0]) || 0;
  return a + S.monthIndex;
}
function currentMonth() { return S.months[S.monthIndex] || MONTHS[0]; }

function freshCampaign(seedStr, mutators, doctrine, scenarioId) {
  const scen = resolveScenario(scenarioId);
  const G = freshState(seedStr, mutators || [], { mode: 'operations', doctrine, scenario: scen.id });
  G.phase = 'briefing';
  G.mode = 'operations';
  G.scenario = scen.id;
  G.doctrine = doctrine || null;
  G.hospitalLoad = 0;
  G.hospitalCapBonus = 0;
  G.tempCapacity = 0;
  G.turn = 0;
  G.monthIndex = 0;
  G.casesPrevented = 0;
  G.swatted = 0;
  G.poolsDrained = 0;
  G.peakHeadroom = 0;
  G.cleanMonths = 0;
  G.scorePenaltyMult = 1;
  G.surgeWardUses = 0;
  return setG(G);
}

function startBriefing() {
  const G = getG();
  S.phase = 'briefing';
  S.briefingT = BRIEFING_SECONDS;
  S.directiveResolved = false;
  S.report = null;
  // Pick directive deterministically from the run rng
  const pickIdx = Math.floor(S.rng() * DIRECTIVE_DECK.length);
  const template = DIRECTIVE_DECK[pickIdx];
  S.directive = {
    id: template.id,
    title: template.title,
    body: template.body,
    options: template.options.map(o => ({ ...o })),
    timeLeft: BRIEFING_SECONDS,
    resolved: false,
    choiceId: null,
  };
  generateShocks();
  // Plan-phase reveal schedule (Surveillance Directorate reveals earlier)
  const def = doctrineDef();
  S.revealTimes = (def && def.mods && def.mods.revealLead) ? [1.0, 3.0] : [...SHOCK_REVEAL_TIMES];
  if (G) { G.phase = 'briefing'; setG(G); }
}

function generateShocks() {
  const G = getG();
  S.shocks = [];
  if (!G) return;
  const scen = S.scenarioDef;
  const absM = absoluteMonthIndex();
  // 1-2 shocks per month, deterministic
  const count = S.rng() < 0.55 ? 1 : 2;
  const weights = SHOCK_TYPES.map(s => {
    let w = 1;
    if (s.type === 'reporting_lag' && scen && scen.reportingLagBoost) w = 3.5;   // ashfall
    if (s.type === 'transit_cluster' && scen && scen.mobilityMult) w = 3;        // corridor
    if (s.type === 'larvae_bloom' && scen && scen.poolSpawnMult) w = 3;          // floodplain
    if (s.type === 'rain_spike' && absM >= 1 && absM <= 3) w = 1.6;              // peak monsoon
    return w;
  });
  const totalW = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < count; i++) {
    let r = S.rng() * totalW, idx = 0;
    for (; idx < weights.length - 1; idx++) { r -= weights[idx]; if (r <= 0) break; }
    const t = SHOCK_TYPES[idx];
    const targetIdx = Math.floor(S.rng() * G.districts.length);
    const did = G.districts[targetIdx].id;
    // True reality applies regardless of player intel (fog of war)
    const td = G.districts[targetIdx];
    td.trueShockMult = (td.trueShockMult || 1.0) * t.mult;
    td.trueDelayedCases = (td.trueDelayedCases || 0) + t.delayed;
    S.shocks.push({
      id: 'shock-' + absM + '-' + i,
      type: t.type,
      label: t.label,
      district: did,
      shockMult: t.mult,
      delayedCases: t.delayed,
      poolsDelta: t.pools,
      timing: (t.type === 'rain_spike' || t.type === 'larvae_bloom') ? 'wave' : 'plan',
      revealed: false,
    });
  }
  // Long-Tail Surveillance can pre-reveal at choice time; applied there.
}

function revealShock(shock) {
  if (!shock || shock.revealed) return;
  shock.revealed = true;
  const G = getG();
  if (!G) return;
  const d = G.districts.find(x => x.id === shock.district);
  if (d) {
    d.revealedShockMult = (d.revealedShockMult || 1) * shock.shockMult;
    d.revealedDelayedCases = (d.revealedDelayedCases || 0) + shock.delayedCases;
    d.intelEvents = d.intelEvents || [];
    d.intelEvents.push({ type: shock.type, label: shock.label });
    d.revealed = true;
  }
}

function applyDirectiveEffect(directiveId, optionId) {
  const G = getG();
  if (!G) return;
  switch (directiveId) {
    case 'el_nino':
      if (optionId === 'a') { addFunds(4); S.waveMods.poolSpawnMult = (S.waveMods.poolSpawnMult || 1) * 0.85; }
      else if (optionId === 'b') { addFunds(-2); S.hospitalCapBonus += 60; G.hospitalCapBonus = S.hospitalCapBonus; }
      break;
    case 'kader':
      if (optionId === 'a') { S.campaignMods.freePsnMonths = 1; }
      else if (optionId === 'b') { S.campaignMods.revealAllMonths = 2; }
      break;
    case 'transit':
      if (optionId === 'a') { S.waveMods.corridorScreening = 0.75; }
      else if (optionId === 'b') { S.hospitalCapBonus += 40; addFunds(3); G.hospitalCapBonus = S.hospitalCapBonus; }
      break;
    case 'shortage':
      if (optionId === 'a') { S.campaignMods.trapEffectMonths = 2; S.campaignMods.fogCostOffsetMonths = 2; }
      else if (optionId === 'b') { addFunds(-4); S.campaignMods.fogUnlimitedMonths = 2; S.campaignMods.fogRadiusBonusMonths = 2; }
      break;
    case 'overload':
      if (optionId === 'a') { S.tempCapacity += 120; S.scorePenaltyMult *= 0.9; G.scorePenaltyMult = S.scorePenaltyMult; }
      else if (optionId === 'b') { S.waveMods.spawnMod = (S.waveMods.spawnMod || 1) * 0.8; S.waveMods.biteSeverityBonus = (S.waveMods.biteSeverityBonus || 0) + 1; }
      break;
    case 'late_monsoon':
      if (optionId === 'a') { addFunds(6); S.waveMods.mosquitoSpeedMult = 1.15; }
      else if (optionId === 'b') {
        for (const s of S.shocks) revealShock(s);
        S.campaignMods.icuLoadRelief = (S.campaignMods.icuLoadRelief || 0) + 30;
      }
      break;
    default: break;
  }
  setG(G);
}

function resolveDirective(optionId) {
  if (S.directiveResolved) return;
  S.directiveResolved = true;
  if (S.directive) {
    S.directive.resolved = true;
    S.directive.choiceId = optionId || null;
    S.directive.timeLeft = 0;
  }
  if (optionId) applyDirectiveEffect(S.directive && S.directive.id, optionId);
  S.phase = 'plan';
  S.planT = 0;
  const G = getG(); if (G) { G.phase = 'plan'; setG(G); }
  SFX.play(optionId ? 'deploy' : 'tap');
}

/* =====================================================================
   PLAN phase: fog of war, protocols, sweeps
   ===================================================================== */
function districtById(id) {
  const G = getG();
  return (G && Array.isArray(G.districts)) ? G.districts.find(d => d.id === id) || null : null;
}
function clinicCost() { return PROTOCOLS.find(p => p.id === 'clinic').costFunds; }
function fogCost() {
  const def = doctrineDef();
  let cost = PROTOCOLS.find(p => p.id === 'fog').costFunds;
  if (def && def.mods && def.mods.fogCostOffset) cost += def.mods.fogCostOffset;
  if (S.campaignMods.fogCostOffsetMonths > 0) cost += 2;
  if (S.campaignMods.fogUnlimitedMonths > 0) return 0;
  return cost;
}
function psnCost() {
  const def = doctrineDef();
  let cost = PROTOCOLS.find(p => p.id === 'psn').costFunds;
  if (def && def.mods && def.mods.psnTrapCostReduction) cost -= def.mods.psnTrapCostReduction;
  if (S.campaignMods.freePsnMonths > 0) return 0;
  return Math.max((def && def.mods && def.mods.minProtocolCost) || 2, cost);
}
function trapsCost() {
  const def = doctrineDef();
  let cost = PROTOCOLS.find(p => p.id === 'traps').costFunds;
  if (def && def.mods && def.mods.psnTrapCostReduction) cost -= def.mods.psnTrapCostReduction;
  return Math.max((def && def.mods && def.mods.minProtocolCost) || 2, cost);
}
function protocolCost(id) {
  switch (id) {
    case 'psn': return psnCost();
    case 'traps': return trapsCost();
    case 'fog': return fogCost();
    case 'clinic': return clinicCost();
    case 'ping': return pingCost();
    default: return 0;
  }
}
function fogUnlimited() { return (S.campaignMods.fogUnlimitedMonths || 0) > 0; }
function fogRadiusBonus() { return (S.campaignMods.fogRadiusBonusMonths || 0) > 0 ? 1 : 0; }
function trapEffectMult() { return (S.campaignMods.trapEffectMonths || 0) > 0 ? 1.2 : 1; }

/* Shared control factor for a district (PSN x Ovitraps x Fog x pool pressure). */
function controlFactorFor(d) {
  if (!d) return 1;
  const reference = Number.isFinite(d.referencePools) ? d.referencePools : (d.pools || 0);
  const poolFactor = clamp(1 + ((d.pools || 0) - reference) * GAME_RULES.poolStep, 0.8, 1.3);
  let factor = (d.proto && d.proto.psn) ? psnFactor() : 1;
  if (d.proto && d.proto.traps) factor *= 1 - 0.15 * trapEffectMult();
  if (d.proto && d.proto.fog) factor *= 0.8;
  return factor * poolFactor;
}
/* Mitigation projection: (1 - control factor) as a percentage. */
function mitigationFor(d) {
  if (!d) return 0;
  return clamp(Math.round((1 - controlFactorFor(d)) * 100), 0, 95);
}

function districtPrediction(d) {
  const epi = d && d.outlook && d.outlook[0] ? d.outlook[0] : (d && d.epi) || null;
  if (!epi) return { median: Math.round(d && d.cases) || 0, low: 0, high: 0 };
  // Revealed surveillance revises the displayed forecast; unrevealed fog stays vague
  const revealed = !!(d && (d.revealed || (S.campaignMods.revealAllMonths || 0) > 0));
  const shock = revealed ? (d.revealedShockMult || 1) : 1;
  const delayed = revealed ? (d.revealedDelayedCases || 0) : 0;
  const mu = (epi.mu || 0) * shock + delayed;
  const low80 = epi.low80 != null ? epi.low80 : (epi.mu || 0) * 0.55;
  const high80 = epi.high80 != null ? epi.high80 : (epi.mu || 0) * 1.6;
  return {
    median: Math.max(0, Math.round(mu)),
    low: Math.max(0, Math.round(low80 * shock + delayed * 0.5)),
    high: Math.max(0, Math.round(high80 * shock + delayed)),
  };
}
function districtRisk(d) {
  const pred = districtPrediction(d);
  const epi = d && d.outlook && d.outlook[0] ? d.outlook[0] : (d && d.epi) || null;
  const threshold = epi && epi.threshold ? epi.threshold : 35;
  return riskOf(pred.median, threshold);
}

function toggleProtocol(id) {
  const G = getG();
  if (!G || S.phase !== 'plan') return false;
  if (id === 'ping') return firePing();
  const d = districtById(S.selectedId || G.selected);
  if (!d) return false;
  const cost = protocolCost(id);
  const active = !!(d.proto && d.proto[id]);
  if (active) {
    d.proto[id] = false;
    if (id !== 'fog' || !fogUnlimited()) addFunds(cost); // refund on toggle-off
    SFX.play('undeploy');
  } else {
    if (!fogUnlimited() && !spendFunds(cost)) { SFX.play('deny'); return false; }
    if (id === 'psn' && (S.campaignMods.freePsnMonths || 0) > 0) S.campaignMods.freePsnMonths -= 1;
    d.proto[id] = true;
    SFX.play('deploy');
  }
  d.mitigationTarget = mitigationFor(d);
  setG(G);
  return true;
}

function firePing() {
  const G = getG();
  if (!G || S.phase !== 'plan') return false;
  if ((S.campaignMods.revealAllMonths || 0) > 0) {
    // Sequencing already reveals everything; ping is free and instant.
    for (const s of S.shocks) revealShock(s);
    SFX.play('deploy');
    setG(G);
    return true;
  }
  const def = doctrineDef();
  const freeAudits = G.freeRiskAudits != null ? G.freeRiskAudits : ((def && def.mods && def.mods.freeRiskAudits) || 0);
  if (freeAudits > 0) {
    G.freeRiskAudits = freeAudits - 1;
  } else {
    if (!spendFunds(pingCost())) { SFX.play('deny'); return false; }
  }
  // Reveal shocks in the selected district (or everywhere if none selected)
  const targetId = S.selectedId || G.selected;
  let revealed = 0;
  for (const s of S.shocks) {
    if (!s.revealed && (!targetId || s.district === targetId)) { revealShock(s); revealed++; }
  }
  const d = targetId ? districtById(targetId) : null;
  if (d) { d.revealed = true; d.radar = true; }
  if (revealed === 0) {
    // No pending shocks: sweep still marks the district as audited
    if (d) d.revealed = true;
  }
  SFX.play('deploy');
  setG(G);
  return true;
}

function commitDeployment() {
  const G = getG();
  if (!G || S.phase !== 'plan') return;
  SFX.play('wave');
  vibrate(35);
  startWave();
}

/* =====================================================================
   WAVE phase
   ===================================================================== */
function currentIntensity() { return (currentMonth() && currentMonth().intensity) || 1; }
function currentRain() { return (currentMonth() && currentMonth().rain) || 1; }
function waveDurationFor() {
  return clamp(Math.round(22 + (currentIntensity() - 0.9) * 15), 22, 28);
}
function scenarioPoolMult() {
  const scen = S.scenarioDef;
  return scen && scen.poolSpawnMult ? scen.poolSpawnMult : 1;
}
function scenarioSpilloverMult(districtId) {
  const scen = S.scenarioDef;
  let m = 1;
  if (scen && scen.mobilityMult && CORRIDOR_HOTSPOTS.includes(districtId)) m *= scen.mobilityMult;
  if (scen && scen.climatePressure && HIGHLAND_HOTSPOTS.includes(districtId)) m *= (1 + scen.climatePressure);
  return m;
}
function localSpawnMod(districtId) {
  let m = (S.waveMods.spawnMod || 1);
  if (S.waveMods.corridorScreening && (districtId === 'sleman' || districtId === 'surakarta')) m *= S.waveMods.corridorScreening;
  return m;
}

/* Mirror of the engine spawn pressure formula (engine keeps it private). */
function spawnCountFor(d) {
  const G = getG();
  const mutators = (G && G.mutators) || [];
  const scen = S.scenarioDef;
  const climate = climateOf(scen && scen.climateProfile);
  const turn = S.monthIndex;
  const absTurn = absoluteMonthIndex();
  const scale = Math.max(1, (d.epi && d.epi.mu) || d.cases || 1);
  const draw = 0.82 + 0.36 * S.waveRng();
  const shock = d.trueShockMult || 1;
  const effectiveMu = (d.epi ? d.epi.mu : d.cases || 0) * shock + (d.trueDelayedCases || 0);
  let pressure = (3 + 4 * effectiveMu / scale + 4 * (d.epi ? (d.epi.eventProb || 0) : 0) + (d.pools || 0) * 0.18) * draw;
  if (mutators.includes('monsoon')) pressure *= 1 + Math.min(0.6, absTurn * 0.1);
  pressure *= (d.proto && d.proto.psn ? 0.5 : 1) * (mutators.includes('swarm') ? 1.4 : 1) * climate.pressure;
  pressure *= localSpawnMod(d.id) * scenarioSpilloverMult(d.id);
  // Commuter corridor: doubled rail spillover feeds the swarm
  if (scen && scen.mobilityMult && CORRIDOR_HOTSPOTS.includes(d.id)) pressure *= 1.15;
  return Math.max(2, Math.round(clamp(pressure, 3, 26)));
}

function pickArchetype(absTurn) {
  const G = getG();
  const mutators = (G && G.mutators) || [];
  const r = S.waveRng();
  // Queen only from JAN onward (abs month index >= 2), guaranteed from month 1 under Royal Hunt
  const queenFloor = (hasMut('royal')) ? 0 : 2;
  if (absTurn >= queenFloor && r < 0.06) return 'queen';
  if (r < 0.18) return 'viremic';
  if (r < 0.42) return 'flanker';
  return 'standard';
}
function riverSpawnPoint() {
  return RIVER_POLYS[Math.floor(S.waveRng() * RIVER_POLYS.length)];
}
function districtSpawnPoint(d, archetype) {
  if (archetype === 'flanker') {
    const [rx, ry] = riverSpawnPoint();
    return [rx + (S.waveRng() - 0.5) * 16, ry + (S.waveRng() - 0.5) * 16];
  }
  const shown = Math.max(1, Math.min(d.pools || 6, 12, (d.pts || []).length || 1));
  const pt = (d.pts && d.pts[Math.floor(S.waveRng() * shown)]) || d.c;
  return [pt[0] + (S.waveRng() - 0.5) * 10, pt[1] + (S.waveRng() - 0.5) * 10];
}
function districtTargetPoint(d) {
  const pt = (d.pts && d.pts.length) ? d.pts[Math.floor(S.waveRng() * d.pts.length)] : d.c;
  return [pt[0], pt[1]];
}

function startWave() {
  const G = getG();
  if (!G) return;
  const absM = absoluteMonthIndex();
  S.waveDuration = waveDurationFor();
  S.waveElapsed = 0;
  S.waveTimeLeft = S.waveDuration;
  S.mosq = []; S.queue = []; S.pools = []; S.standingPools = [];
  S.traps = []; S.fogT = {}; S.friendlies = [];
  S.sprayBursts = []; S.slashes = []; S.trail = [];
  S.pointerActive = false;
  S.combo = 0; S.comboT = 0; S.maxCombo = 0;
  S.pressure = 0; S.bites = 0; S.surgeUsed = false; S.waveSpawned = 0;
  S.sprayCharge = clamp(S.sprayCharge + perkCount('spray') * 20, 0, 100);
  S.comboWindow = 1.8 + (hasG('combo') ? 1.0 : 0);

  for (const s of S.shocks) {
    if (s.poolsDelta && !s.poolsApplied) {
      const d = districtById(s.district);
      if (d) d.pools = clamp((d.pools || 0) + s.poolsDelta, 2, 22);
      s.poolsApplied = true;
    }
  }

  for (const d of G.districts) {
    const n = spawnCountFor(d);
    for (let i = 0; i < n; i++) {
      S.queue.push({ t: 0.3 + S.waveRng() * (S.waveDuration - 2.6), did: d.id, archetype: pickArchetype(absM) });
    }
  }
  if (hasMut('royal')) {
    const worst = [...G.districts].sort((a, b) => (((b.epi && b.epi.eventProb) || 0) - ((a.epi && a.epi.eventProb) || 0)))[0];
    S.queue.push({ t: S.waveDuration * 0.45, did: worst.id, archetype: 'queen' });
  }
  S.queue.sort((a, b) => a.t - b.t);
  S.waveTotal = S.queue.length;

  const poolBase = 2 + Math.floor(S.waveRng() * 3);
  const poolTarget = Math.round(poolBase * scenarioPoolMult() * (S.waveMods.poolSpawnMult || 1));
  let guard = 0;
  const riparian = (S.scenarioDef && S.scenarioDef.poolSpawnMult)
    ? G.districts.filter(d => RIPARIAN_HOTSPOTS.includes(d.id)) : [];
  while (S.standingPools.length < poolTarget && guard++ < 60) {
    let d;
    if (riparian.length && S.waveRng() < 0.7) d = riparian[Math.floor(S.waveRng() * riparian.length)];
    else d = G.districts[Math.floor(S.waveRng() * G.districts.length)];
    if (!d || (d.pools || 0) < 2) continue;
    const [x, y] = districtSpawnPoint(d, 'standard');
    S.standingPools.push({ id: 'pool-' + S.standingPools.length, x, y, did: d.id, drain: 0, seed: Math.floor(S.waveRng() * 10000), rx: 9 + S.waveRng() * 4 });
  }

  // Ovitraps deployed on the field (auto-catch within radius)
  const trapRadius = 28 * (hasG('traps2') ? 1.5 : 1);
  const trapCdMax = hasG('traps2') ? 0.42 : 0.8;
  for (const d of G.districts) {
    if (!d.proto || !d.proto.traps) continue;
    for (const [tx, ty] of (d.trapPts || [])) {
      S.traps.push({ x: tx, y: ty, did: d.id, cd: 0, pulse: 0, radius: trapRadius, cdMax: trapCdMax });
    }
  }
  // Fog strike schedule for fogged districts
  S.fogInterval = hasG('fog2') ? 2 : 3;
  for (const d of G.districts) {
    if (d.proto && d.proto.fog) S.fogT[d.id] = 0.5 + S.waveRng() * 0.8;
  }
  // Wolbachia allies intercept nearby wild vectors
  const allies = perkCount('wolbachia') > 0 ? 1 + perkCount('wolbachia') : 0;
  for (let i = 0; i < allies; i++) {
    S.friendlies.push({ x: 350, y: 250, vx: 0, vy: 0, charges: 2, age: 0 });
  }

  const W = {
    t: 0, dur: S.waveDuration, queue: S.queue, mosq: S.mosq,
    swats: 0, escaped: 0, auto: 0, combo: 0, comboT: 0, maxCombo: 0,
    total: S.waveTotal, over: false, paused: false, resolved: false,
    serial: G.serial, phase: 'wave',
    byDistrict: Object.fromEntries(G.districts.map(d => [d.id, { total: 0, defeated: 0, bites: 0, drained: 0, swats: 0 }])),
    waveRng: S.waveRng,
  };
  for (const q of S.queue) if (W.byDistrict[q.did]) W.byDistrict[q.did].total++;
  setW(W);

  S.phase = 'wave';
  G.phase = 'wave';
  setG(G);
}

function spawnMosquito(q) {
  const G = getG();
  if (!G) return null;
  const d = districtById(q.did);
  if (!d) return null;
  const absTurn = absoluteMonthIndex();
  const [px, py] = districtSpawnPoint(d, q.archetype);
  const [tx, ty] = districtTargetPoint(d);
  const speedBase = q.archetype === 'flanker' ? 52 + S.waveRng() * 14
    : q.archetype === 'queen' ? 26 + S.waveRng() * 6
    : q.archetype === 'viremic' ? 36 + S.waveRng() * 8
    : 34 + S.waveRng() * 14;
  const m = {
    x: px, y: py, vx: 0, vy: 0, tx, ty,
    did: d.id, age: 0, ph: S.waveRng() * TAU,
    archetype: q.archetype,
    speed: speedBase * ((S.waveMods.mosquitoSpeedMult || 1)) * (hasG('lotion') ? 0.8 : 1),
    hp: q.archetype === 'queen' ? (hasMut('hardy') ? 3 : 2) : (hasMut('hardy') ? 2 : 1),
    maxHp: q.archetype === 'queen' ? (hasMut('hardy') ? 3 : 2) : (hasMut('hardy') ? 2 : 1),
    dead: false, hurt: 0,
  };
  S.mosq.push(m);
  S.waveSpawned++;
  return m;
}

function biteSeverity() {
  return (S.waveMods.biteSeverityBonus || 0);
}
function biteWeightOf(m) {
  const base = m.archetype === 'viremic' ? VIREMIC_BED_WEIGHT
    : m.archetype === 'queen' ? QUEEN_BED_WEIGHT : ESCAPE_BED_WEIGHT;
  return base + biteSeverity();
}

function onBite(m) {
  const G = getG();
  const W = getW();
  m.dead = true;
  S.bites++;
  S.pressure += biteWeightOf(m);
  if (W) { W.escaped++; if (W.byDistrict && W.byDistrict[m.did]) W.byDistrict[m.did].bites++; }
  if (S.combo >= 3 && S.fx) S.fx.floatText(m.x, m.y - 12, 'COMBO LOST', { color: '#8FA8B2', size: 11 });
  S.combo = 0; S.comboT = 0;
  if (S.fx) {
    S.fx.floatText(m.x, m.y, 'BITE', { color: '#FFB2B8', size: m.archetype === 'queen' ? 17 : 12 });
    S.fx.splat(m.x, m.y, { color: '#EF4444', size: m.archetype === 'queen' ? 12 : 8 });
  }
  // Brood Queen reaching her target drops a breeding pool behind her
  if (m.archetype === 'queen') {
    const d = districtById(m.did);
    if (d) d.pools = clamp((d.pools || 0) + 1, 2, 22);
    S.standingPools.push({ id: 'pool-q-' + S.mosquitoSeq(), x: m.x, y: m.y, did: m.did, drain: 0, seed: Math.floor(S.waveRng() * 10000), rx: 10 });
  }
  SFX.play('bite');
  vibrate(m.archetype === 'queen' ? 80 : 20);
  if (W) setW(W);
  if (G) setG(G);
}
S.mosquitoSeq = (() => { let n = 0; return () => ++n; })();

/* Combo + spray charge */
function comboMult() {
  const t = hasG('combo') ? [3, 7, 14] : [5, 10, 20];
  return S.combo >= t[2] ? 3 : S.combo >= t[1] ? 2 : S.combo >= t[0] ? 1.5 : 1;
}
function registerKill(m, withCombo) {
  const G = getG();
  const W = getW();
  S.swatted++;
  if (W) { W.swats++; if (W.byDistrict && W.byDistrict[m.did]) W.byDistrict[m.did].swats++; }
  if (withCombo) {
    S.combo += 1;
    S.comboT = S.comboWindow;
    S.maxCombo = Math.max(S.maxCombo, S.combo);
    const mult = comboMult();
    S.sprayCharge = clamp(S.sprayCharge + 5 * mult * sprayChargeFactor(), 0, 100);
    if (S.fx) S.fx.floatText(m.x, m.y - 10, '+' + Math.round(10 * mult), { color: mult >= 2 ? '#FBBF24' : '#E6F0F2', size: 12 + mult * 2 });
    SFX.play(m.archetype === 'queen' ? 'zap' : 'swat');
  } else {
    if (W) W.auto++;
    if (S.fx) S.fx.floatText(m.x, m.y - 10, '+25', { color: '#A5F690', size: 11 });
  }
  if (W) setW(W);
  if (G) setG(G);
}

function killMosquito(m, cause) {
  if (!m || m.dead) return;
  m.dead = true;
  if (S.fx) S.fx.splat(m.x, m.y, { color: cause === 'spray' ? '#7DD3FC' : '#EF4444', size: m.archetype === 'queen' ? 12 : 9 });
  registerKill(m, cause === 'swat' || cause === 'slice');
  if (m.archetype === 'queen' && S.fx) S.fx.burst(m.x, m.y, { color: '#FBBF24', count: 16 });
}

function damageMosquito(m, cause) {
  if (!m || m.dead) return false;
  m.hp -= 1;
  m.hurt = 0.2;
  if (m.hp > 0) {
    if (S.fx) S.fx.burst(m.x, m.y, { color: '#B3B0FE', count: 6, speed: 70 });
    SFX.play('hit');
    return false;
  }
  killMosquito(m, cause);
  return true;
}

function swatSegment(x1, y1, x2, y2, isSwipe) {
  if (S.phase !== 'wave') return;
  const R = swatRadius();

  // 1) Drain standing pools along the segment
  for (const pool of S.standingPools) {
    if (pool.drain >= 1) continue;
    const d = distToSegment(pool.x, pool.y, x1, y1, x2, y2);
    if (d < 30 + (pool.rx || 9)) {
      const drainMult = scenarioPoolMult() > 1 ? 2 : 1;   // bengawan: richer rewards handled at resolution
      pool.drain = clamp(pool.drain + poolStep() * drainMult, 0, 1);
      if (pool.drain >= 1) {
        S.poolsDrained++;
        const bonus = Math.round(90 * (scenarioPoolMult() > 1 ? 2 : 1));
        if (S.fx) { S.fx.floatText(pool.x, pool.y - 12, 'DRAINED +' + bonus, { color: '#7DD3FC', size: 13 }); S.fx.burst(pool.x, pool.y, { color: '#38BDF8', count: 10 }); }
        SFX.play('drain');
        vibrate(18);
        const dd = districtById(pool.did);
        if (dd) dd.pools = Math.max(2, (dd.pools || 2) - 1);
        const W = getW();
        if (W && W.byDistrict && W.byDistrict[pool.did]) W.byDistrict[pool.did].drained++;
        const G = getG(); if (G) { G.poolsDrained = S.poolsDrained; setG(G); }
        if (W) setW(W);
      }
    }
  }

  // 2) Hit mosquitoes along the segment
  const hits = [];
  for (const m of S.mosq) {
    if (m.dead) continue;
    const d = distToSegment(m.x, m.y, x1, y1, x2, y2);
    if (d < R * (m.archetype === 'queen' ? 1.5 : 1)) hits.push(m);
  }
  hits.sort((a, b) => a.x - b.x);
  for (const m of hits) damageMosquito(m, isSwipe ? 'slice' : 'swat');
  if (!hits.length && !isSwipe) SFX.play('miss');
}

function triggerSprayBurst(pt) {
  if (S.phase !== 'wave') return false;
  if (S.sprayCharge < 100) { SFX.play('deny'); return false; }
  const target = pt && Number.isFinite(pt.x) ? pt : (S.lastPt || { x: 350, y: 250 });
  S.sprayCharge = 0;
  const radius = sprayRadiusMap();
  S.sprayBursts.push({ x: target.x, y: target.y, t: 0, progress: 0, maxRadius: radius });
  let count = 0;
  for (const m of S.mosq) {
    if (m.dead) continue;
    if (Math.hypot(m.x - target.x, m.y - target.y) <= radius) {
      if (m.archetype === 'queen') { damageMosquito(m, 'spray'); if (!m.dead) damageMosquito(m, 'spray'); }
      else { m.hp = 0; killMosquito(m, 'spray'); }
      count++;
    }
  }
  // Seal nearby pools by 40%
  for (const pool of S.standingPools) {
    if (pool.drain >= 1) continue;
    if (Math.hypot(pool.x - target.x, pool.y - target.y) <= radius) {
      pool.drain = clamp(pool.drain + 0.4, 0, 1);
      if (pool.drain >= 1) {
        S.poolsDrained++;
        const dd = districtById(pool.did);
        if (dd) dd.pools = Math.max(2, (dd.pools || 2) - 1);
      }
    }
  }
  if (S.fx) {
    S.fx.floatText(target.x, target.y, 'PURGED ' + count, { color: '#7DD3FC', size: 16 });
    S.fx.burst(target.x, target.y, { color: '#38BDF8', count: 22, speed: 160 });
  }
  SFX.play('spray');
  vibrate([50, 40, 80]);
  const W = getW(); if (W) setW(W);
  return true;
}

function buySurgeWard() {
  const G = getG();
  if (!G || S.phase !== 'wave' || S.surgeUsed) return false;
  if (G.budget < SURGE_WARD_COST) { SFX.play('deny'); return false; }
  G.budget -= SURGE_WARD_COST;
  S.surgeUsed = true;
  S.pressure = Math.max(0, S.pressure - SURGE_WARD_RELIEF);
  G.surgeWardUses = (G.surgeWardUses || 0) + 1;
  if (S.fx && S.lastPt) S.fx.floatText(S.lastPt.x, S.lastPt.y - 20, 'SURGE WARD -' + SURGE_WARD_RELIEF, { color: '#34D399', size: 13 });
  SFX.play('heal');
  setG(G);
  return true;
}

/* Wave update: movement, spawning, timers */
function updateWave(dt, now) {
  const G = getG();
  const W = getW();
  S.waveElapsed += dt;
  S.waveTimeLeft = Math.max(0, S.waveDuration - S.waveElapsed);
  if (W) { W.t = S.waveElapsed; }

  // Combo decay
  if (S.combo > 0) {
    S.comboT -= dt;
    if (S.comboT <= 0) { S.combo = 0; S.comboT = 0; }
  }

  // Flush spawn queue
  while (S.queue.length && S.queue[0].t <= S.waveElapsed) {
    spawnMosquito(S.queue.shift());
  }

  // Mosquito steering
  for (const m of S.mosq) {
    if (m.dead) continue;
    m.age += dt;
    if (m.hurt > 0) m.hurt -= dt;
    const dx = m.tx - m.x, dy = m.ty - m.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (dist < 9) { onBite(m); continue; }
    const nx = dx / dist, ny = dy / dist;
    const weaveAmp = m.archetype === 'flanker' ? 1.7 : 0.9;
    const weaveFreq = m.archetype === 'flanker' ? 8.5 : 6;
    const w = Math.sin(m.age * weaveFreq + m.ph) * weaveAmp;
    const k = Math.min(1, dt * 4);
    const tvx = (nx - ny * w) * m.speed, tvy = (ny + nx * w) * m.speed;
    m.vx += (tvx - m.vx) * k;
    m.vy += (tvy - m.vy) * k;
    m.x += m.vx * dt;
    m.y += m.vy * dt;
  }
  S.mosq = S.mosq.filter(m => !m.dead);

  // Ovitraps auto-catch
  for (const tr of S.traps) {
    if (tr.pulse > 0) tr.pulse -= dt;
    if (tr.cd > 0) { tr.cd -= dt; continue; }
    let best = null, bd = Infinity;
    for (const m of S.mosq) {
      if (m.dead) continue;
      const d = Math.hypot(m.x - tr.x, m.y - tr.y);
      if (d < tr.radius && d < bd) { bd = d; best = m; }
    }
    if (best) { tr.cd = tr.cdMax; tr.pulse = 0.4; killMosquito(best, 'trap'); }
  }

  // Fogging strikes on fogged districts
  for (const did of Object.keys(S.fogT)) {
    S.fogT[did] -= dt;
    if (S.fogT[did] > 0) continue;
    S.fogT[did] = S.fogInterval || 3;
    const d = districtById(did);
    if (!d) continue;
    const r = 26 + (fogRadiusBonus() ? 14 : 0);
    S.sprayBursts.push({ x: d.c[0], y: d.c[1], t: 0, progress: 0, maxRadius: r, color: '#CBD5E1' });
    let hits = 0;
    for (const m of S.mosq) {
      if (m.dead) continue;
      if (Math.hypot(m.x - d.c[0], m.y - d.c[1]) <= r) { damageMosquito(m, 'fog'); hits++; }
    }
    if (hits) SFX.play('fog');
  }

  // Wolbachia allies chase and intercept wild vectors
  for (const f of S.friendlies) {
    if (f.charges <= 0) continue;
    f.age += dt;
    let best = null, bd = Infinity;
    for (const m of S.mosq) {
      if (m.dead) continue;
      const d = Math.hypot(m.x - f.x, m.y - f.y);
      if (d < bd) { bd = d; best = m; }
    }
    if (best) {
      const dx = best.x - f.x, dy = best.y - f.y, dist = Math.hypot(dx, dy) || 1;
      const sp = 62;
      f.vx = (dx / dist) * sp; f.vy = (dy / dist) * sp;
      f.x += f.vx * dt; f.y += f.vy * dt;
      if (dist < 8) {
        killMosquito(best, 'ally');
        f.charges -= 1;
        if (S.fx) S.fx.floatText(f.x, f.y, 'ALLY', { color: '#2DD4BF', size: 11 });
      }
    } else {
      // Idle orbit around corridor center until prey appears
      f.x += Math.cos(f.age * 0.9) * 12 * dt;
      f.y += Math.sin(f.age * 1.1) * 12 * dt;
    }
  }
  S.friendlies = S.friendlies.filter(f => f.charges > 0);

  // Spray bursts animation
  for (const b of S.sprayBursts) { b.t += dt; b.progress = clamp(b.t / 0.55, 0, 1); }
  S.sprayBursts = S.sprayBursts.filter(b => b.progress < 1);

  if (W) {
    W.mosq = S.mosq;
    W.combo = S.combo; W.comboT = S.comboT; W.maxCombo = S.maxCombo;
    W.escaped = S.bites;
    if (S.combo > (W.maxCombo || 0)) W.maxCombo = S.combo;
    setW(W);
  }
  if (G) setG(G);

  // Buzz intensity throttled
  S.buzzTimer -= dt;
  if (S.buzzTimer <= 0) { S.buzzTimer = 0.5; try { SFX.setBuzz(S.mosq.length); } catch (e) { /* audio optional */ } }

  // End of wave?
  const hostilesLeft = S.mosq.length + S.queue.length;
  if (S.waveElapsed >= S.waveDuration && hostilesLeft === 0) {
    endWave();
  }
}

/* =====================================================================
   Wave resolution -> REPORT
   ===================================================================== */
function endWave() {
  const G = getG();
  const W = getW();
  if (!G) return;
  const M = currentMonth();
  const absM = absoluteMonthIndex();
  try { SFX.stopBuzz(); SFX.stopMusic(); } catch (e) { /* audio optional */ }

  const districtResults = [];
  let totalCases = 0;
  let totalBaseline = 0;
  for (const d of G.districts) {
    const stats = (W && W.byDistrict && W.byDistrict[d.id]) || { total: 0, defeated: 0, bites: 0, drained: 0, swats: 0 };
    const trueShock = d.trueShockMult || 1;
    const trueDelayed = d.trueDelayedCases || 0;
    const effectiveMu = Math.max(1e-5, (d.epi ? d.epi.mu : (d.cases || 10)) * trueShock);
    let baseline = 0;
    try {
      baseline = Math.round(EpiRuntime.sample(effectiveMu, (d.epi && d.epi.kappa) || 6, S.rng) + trueDelayed);
    } catch (e) {
      baseline = Math.round(effectiveMu + trueDelayed);
    }
    const biteShare = clamp(stats.bites / Math.max(1, stats.total), 0, 1);
    const arcade = GAME_RULES.perfectArcadeFactor + GAME_RULES.missedArcadeSpan * biteShare;
    const control = controlFactorFor(d);
    const drainMult = Math.pow(drainFactor(), stats.drained || 0);
    const factor = control * drainMult * arcade;
    const cases = Math.max(0, Math.round(baseline * factor));
    const prevented = Math.max(0, baseline - cases);
    totalCases += cases;
    totalBaseline += baseline;
    S.casesPrevented += prevented;
    d.cases = cases;
    (G.modelHistory || (G.modelHistory = {}))[d.id] = (G.modelHistory[d.id] || {});
    G.modelHistory[d.id][MODEL_TARGET(absM)] = cases;
    districtResults.push({ id: d.id, name: d.name, baseline, cases, prevented, biteShare, drained: stats.drained || 0, swats: stats.swats || 0, bites: stats.bites || 0 });
  }

  // Fever pressure contributes ICU bed demand (Viremic bites weigh 2x)
  const relief = (S.campaignMods.icuLoadRelief || 0);
  const pressureBeds = Math.max(0, S.pressure);
  const load = Math.max(0, Math.round(totalCases + pressureBeds - relief));
  const cap = hospitalCap();
  const bedsAdded = activeClinicCount() * clinicSlots() + S.tempCapacity;
  G.hospitalLoad = load;
  G.tempCapacity = 0;
  S.tempCapacity = 0;

  const headroom = Math.max(0, cap - load);
  if (headroom > S.peakHeadroom) S.peakHeadroom = headroom;
  if (S.bites === 0) S.cleanMonths += 1;

  // Budget refill
  const incomeBase = 4 + Math.floor((G.trust || 0) / 20) + perkCount('grants') * 2;
  const income = Math.max(2, Math.round(incomeBase * (hasMut('budget') ? 0.7 : 1)));
  G.budget = Math.min(999, (G.budget || 0) + income);

  // Grade from bite ratio
  const totalBites = S.bites;
  const totalTotal = Math.max(1, S.waveTotal);
  const ratio = totalBites / totalTotal;
  const grade = ratio <= 0.10 ? 'S' : ratio <= 0.25 ? 'A' : ratio <= 0.45 ? 'B' : 'C';

  // Score bookkeeping
  G.casesPrevented = S.casesPrevented;
  G.swatted = S.swatted;
  G.poolsDrained = S.poolsDrained;
  G.peakHeadroom = S.peakHeadroom;
  G.cleanMonths = S.cleanMonths;
  G.score = computeScore();

  // District pool regeneration for next month
  for (const d of G.districts) {
    if (d.proto && d.proto.psn) d.pools = Math.max(2, (d.pools || 2) - 5);
    d.pools = clamp((d.pools || 2) + M.poolDelta * (hasMut('monsoon') ? 2 : 1), 2, 22);
    d.revealedShockMult = 1;
    d.revealedDelayedCases = 0;
    d.trueShockMult = 1.0;
    d.trueDelayedCases = 0;
    d.revealed = (S.campaignMods.revealAllMonths || 0) > 0;
    d.radar = false;
    d.mitigationShown = 0;
    d.mitigationTarget = 0;
    if (d.proto) { d.proto.psn = false; d.proto.traps = false; d.proto.fog = false; d.proto.clinic = false; }
  }
  // Decay multi-month directive effects
  if (S.campaignMods.revealAllMonths > 0) S.campaignMods.revealAllMonths -= 1;
  if (S.campaignMods.trapEffectMonths > 0) S.campaignMods.trapEffectMonths -= 1;
  if (S.campaignMods.fogCostOffsetMonths > 0) S.campaignMods.fogCostOffsetMonths -= 1;
  if (S.campaignMods.fogUnlimitedMonths > 0) S.campaignMods.fogUnlimitedMonths -= 1;
  if (S.campaignMods.fogRadiusBonusMonths > 0) S.campaignMods.fogRadiusBonusMonths -= 1;
  S.campaignMods.icuLoadRelief = 0;
  // freePsnMonths is consumed by toggles; expire leftovers after the month
  S.campaignMods.freePsnMonths = 0;
  S.waveMods = {};

  const report = {
    monthIndex: S.monthIndex,
    monthTotal: S.months.length,
    monthLabel: M.m,
    monthName: M.name,
    bedsFreed: headroom,
    bedsAdded,
    casesPrevented: S.casesPrevented,
    casesPreventedThisWave: districtResults.reduce((n, r) => n + r.prevented, 0),
    totalCases,
    baseline: totalBaseline,
    icuLoad: load,
    icuCap: cap,
    grade,
    budgetRefill: income,
    cleanMonth: S.bites === 0,
    districts: districtResults,
    auditAvailable: true,
    auditPillLabel: trOr('mode1.auditPill', '[ Audit in EpiKD Lab ]'),
    auditEvent: 'dd:open-epikd-audit',
  };
  S.report = report;
  G.reports = G.reports || [];
  G.reports.push(report);
  G.phase = 'report';
  setG(G);
  if (W) { W.over = true; W.resolved = true; W.phase = 'report'; setW(W); }

  // Hospital overflow -> defeat
  if (load > cap) {
    S.phase = 'end';
    S.result = 'hospital';
    G.phase = 'end';
    G.result = 'hospital';
    setG(G);
    callGameOver('hospital');
    return;
  }
  S.phase = 'report';
  SFX.play('report');
}
function MODEL_TARGET(absM) { return 202400 + absM; }

function continueFromReport() {
  const G = getG();
  if (!G || S.phase !== 'report') return;
  const isLast = S.monthIndex >= S.months.length - 1;
  if (isLast) { victory(); return; }
  // Deal 3 perk choices
  const pool = PERKS.filter(p => p.stack || !(G.perks && G.perks[p.id]));
  const choices = [];
  const bag = pool.slice();
  while (choices.length < 3 && bag.length) {
    const i = Math.floor(S.rng() * bag.length);
    choices.push(bag.splice(i, 1)[0]);
  }
  S.perkChoices = choices.map(p => p.id);
  S.phase = 'perk';
  G.phase = 'perk';
  G.perkChoices = S.perkChoices.slice();
  setG(G);
  SFX.play('tap');
}

function choosePerk(perkId) {
  const G = getG();
  if (!G || S.phase !== 'perk') return false;
  if (!perkId || !S.perkChoices.includes(perkId)) return false;
  const perk = PERKS.find(p => p.id === perkId);
  if (!perk) return false;
  // Apply via a state shim, then fold back into G
  const shim = {
    unitsMax: G.unitsMax || 4,
    capacity: S.hospitalCapBonus,
    trust: G.trust || 0,
  };
  if (typeof perk.apply === 'function') {
    try { perk.apply(shim); } catch (e) { /* perk effect is best-effort */ }
    G.unitsMax = shim.unitsMax;
    if (Number.isFinite(shim.capacity)) S.hospitalCapBonus = shim.capacity;
    G.trust = clamp(shim.trust, 0, 100);
  }
  G.perks = G.perks || {};
  G.perks[perkId] = (G.perks[perkId] || 0) + 1;
  G.hospitalCapBonus = S.hospitalCapBonus;
  // Advance month
  S.monthIndex += 1;
  G.turn = S.monthIndex;
  G.monthIndex = S.monthIndex;
  setG(G);
  SFX.play('combo');
  vibrate(20);
  startBriefing();
  return true;
}

function victory() {
  const G = getG();
  S.phase = 'end';
  S.result = 'victory';
  G.phase = 'end';
  G.result = 'victory';
  G.casesPrevented = S.casesPrevented;
  G.swatted = S.swatted;
  G.poolsDrained = S.poolsDrained;
  G.peakHeadroom = S.peakHeadroom;
  G.cleanMonths = S.cleanMonths;
  G.score = computeScore();
  setG(G);
  try { SFX.play('win'); } catch (e) { /* audio optional */ }
  vibrate([30, 30, 30, 30, 80]);
}

/* =====================================================================
   update()
   ===================================================================== */
const OperationsMode = {
  id: 'operations',
  supportsPause: true,
  usesRealTimeCanvasLoop: true,

  init({ seedStr, seed, doctrine, scenario, mutators } = {}) {
    resetRunState();
    S.seedStr = seedStr || (seed != null ? String(seed) : 'MONSOON-ALPHA-001');
    S.seed = (typeof seed === 'number' && Number.isFinite(seed)) ? (seed >>> 0) : parseSeed(String(seed ?? S.seedStr));
    S.doctrine = doctrine || null;
    S.scenario = scenario || 'solo_basin';
    S.scenarioDef = resolveScenario(S.scenario);
    S.months = monthsForScenario(S.scenarioDef);
    S.rng = mulberry32(S.seed);
    S.waveRng = mulberry32((S.seed + 0x9E3779B9) >>> 0);
    S.fx = new FX();

    const G = freshCampaign(S.seedStr, mutators, S.doctrine, S.scenario);
    const def = doctrineDef();
    G.freeRiskAudits = (def && def.mods && def.mods.freeRiskAudits) || 0;
    G.mutators = Array.isArray(mutators) ? mutators.slice() : [];
    S.selectedId = G.selected || 'klaten';
    for (const d of G.districts) {
      d.revealed = false; d.radar = false;
      d.mitigationShown = 0; d.mitigationTarget = mitigationFor(d);
      d.proto = { psn: false, traps: false, fog: false, clinic: false };
    }
    setG(G);

    S.active = true;
    registerListeners();
    startBriefing();
    computeScore();
    return OperationsMode;
  },

  dispose() {
    S.active = false;
    unregisterListeners();
    try { SFX.stopBuzz(); SFX.stopMusic(); } catch (e) { /* audio optional */ }
    S.mosq = []; S.queue = []; S.pools = []; S.standingPools = [];
    S.sprayBursts = []; S.trail = []; S.slashes = [];
    if (S.fx) S.fx.clear();
    setW(null);
    S.phase = 'idle';
  },

  update(dt, now) {
    if (!S.active || S.paused) return;
    const step = clamp(Number(dt) || 0, 0, 0.1);
    const G = getG();

    // Smooth mitigation gauges toward targets
    if (G && Array.isArray(G.districts)) {
      for (const d of G.districts) {
        const target = d.mitigationTarget != null ? d.mitigationTarget : 0;
        d.mitigationShown = Math.abs(target - (d.mitigationShown || 0)) < 0.4
          ? target : lerp(d.mitigationShown || 0, target, Math.min(1, step * 6));
      }
    }

    switch (S.phase) {
      case 'briefing':
        S.briefingT = Math.max(0, S.briefingT - step);
        if (S.directive) S.directive.timeLeft = S.briefingT;
        if (S.briefingT <= 0 && !S.directiveResolved) resolveDirective(null);
        break;
      case 'plan': {
        S.planT += step;
        for (let i = 0; i < S.revealTimes.length; i++) {
          if (S.planT >= S.revealTimes[i] && S.shocks[i] && !S.shocks[i].revealed) {
            revealShock(S.shocks[i]);
            if (isBrowser()) dispatch('dd:shock-revealed', { shockId: S.shocks[i].id, type: S.shocks[i].type });
          }
        }
        if ((S.campaignMods.revealAllMonths || 0) > 0) {
          for (const s of S.shocks) revealShock(s);
        }
        break;
      }
      case 'wave':
        updateWave(step, now);
        break;
      default:
        break;
    }
  },

  /* render(ctx, view, now): corridor map -> districts -> markers -> entities -> FX.
     `view` is the shared corridor view { w, h, dpr, scale, ox, oy, time }.
     The function applies the corridor transform itself so the mode can be
     driven directly by the shell without pre-transforming ctx. */
  render(ctx, view, now) {
    if (!ctx) return;
    const v = view || getView();
    const dpr = v.dpr || 1;
    const scale = v.scale || 1;
    const ox = v.ox || 0, oy = v.oy || 0;
    const time = (v.time != null ? v.time : (now != null ? now / 1000 : 0));
    const nowT = now != null ? now : nowMs();
    const G = getG();

    // ---- Screen-space pass: background ----
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.w || 700, v.h || 500);
    drawMapBackground(ctx, { ...v, time });
    ctx.restore();

    // ---- Map-space pass: corridor transform ----
    ctx.save();
    ctx.setTransform(
      dpr * scale, 0, 0, dpr * scale,
      dpr * (ox - CORRIDOR.MX0 * scale),
      dpr * (oy - CORRIDOR.MY0 * scale),
    );
    ctx.lineWidth = 1 / Math.max(scale, 0.01);

    drawMerapiContour(ctx, { time });
    drawRiverCurves(ctx, RIVERS, time);

    // Districts (choropleth; unrevealed districts render dimmed)
    if (G && Array.isArray(G.districts)) {
      for (const d of G.districts) {
        const risk = districtRisk(d);
        const revealed = !!d.revealed || (S.campaignMods.revealAllMonths || 0) > 0;
        drawDistrictPolygon(ctx, { ...d, risk }, { time, selected: d.id === S.selectedId, alpha: revealed ? undefined : 0.10 });
        // Centroid labels: forecast band when unrevealed, live tally when revealed
        const pred = districtPrediction(d);
        ctx.save();
        ctx.font = '600 10px "Cascadia Mono", Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(230, 240, 242, 0.82)';
        ctx.fillText(d.name || String(d.id).toUpperCase(), d.c[0], d.c[1] - 10);
        ctx.font = '9px "Cascadia Mono", Consolas, monospace';
        ctx.fillStyle = revealed ? 'rgba(125, 211, 252, 0.9)' : 'rgba(143, 168, 178, 0.75)';
        ctx.fillText(revealed ? ('CENSUS ' + Math.round(d.cases || 0)) : ('FA ' + pred.low + '-' + pred.high), d.c[0], d.c[1] + 2);
        if (!revealed) {
          ctx.fillStyle = 'rgba(245, 158, 11, 0.65)';
          ctx.fillText('NO INTEL', d.c[0], d.c[1] + 13);
        }
        ctx.restore();
        // Selection lock marker (dashed amber handled by drawDistrictPolygon)
        if (d.radar) drawHotspotNode(ctx, d.c[0], d.c[1] - 22, { time, color: '#38BDF8', intensity: 0.8 });
      }

      // Protocol unit markers anchored at centroids
      for (const d of G.districts) {
        if (!d.proto) continue;
        let offset = 0;
        for (const kind of ['psn', 'traps', 'fog', 'clinic']) {
          if (d.proto[kind]) {
            drawUnitMarker(ctx, d.c[0] - 18 + offset * 12, d.c[1] + 18, kind, { time, scale: 0.72, active: true });
            offset += 1;
          }
        }
      }
    }

    // Standing breeding pools with drain gauge
    for (const pool of S.standingPools) {
      drawStandingPool(ctx, pool.x, pool.y, { rx: pool.rx || 9, seed: pool.seed || 1, drain: pool.drain || 0, time });
    }

    // Deployed ovitraps (amber canisters pulse on a catch)
    for (const tr of S.traps) {
      drawUnitMarker(ctx, tr.x, tr.y, 'traps', { time, scale: tr.pulse > 0 ? 0.62 : 0.45, active: true });
    }

    // Wolbachia allies (teal interceptors)
    for (const f of S.friendlies) {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.strokeStyle = '#2DD4BF';
      ctx.fillStyle = 'rgba(45, 212, 191, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, 4.5, 0, TAU);
      ctx.fill();
      ctx.stroke();
      const wob = Math.sin(time * 22 + f.age * 9) * 0.8;
      ctx.beginPath(); ctx.ellipse(-4.4, -3, 4 + wob, 1.5, -0.5, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(4.4, -3, 4 - wob, 1.5, 0.5, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    // Mosquitoes
    for (const m of S.mosq) {
      if (m.dead) continue;
      const angle = Math.atan2(m.vy || 0, m.vx || 0) + Math.PI / 2;
      drawMosquitoSprite(ctx, m.x, m.y, {
        archetype: m.archetype,
        angle,
        time: time + (m.ph || 0),
        hp: m.hp,
        maxHp: m.maxHp,
        halo: m.archetype === 'standard' ? clamp(1 - Math.hypot(m.tx - m.x, m.ty - m.y) / 220, 0, 1) : 0,
        locked: m.archetype === 'viremic',
        alpha: m.hurt > 0 ? 0.75 : 1,
      });
    }

    // Slash trail (pointer swat)
    if (S.trail.length > 1) drawSlashTrail(ctx, S.trail, { now: nowT, lifetime: 180, width: 7 });

    // Containment spray shockwaves
    for (const b of S.sprayBursts) {
      drawSprayBurst(ctx, b.x, b.y, b.progress, { maxRadius: b.maxRadius, color: b.color || '#38BDF8', mist: 16 });
    }

    // FX particles
    if (S.fx) S.fx.draw(ctx, nowT);

    ctx.restore();

    // ---- Phase banner ribbon (map-space overlay drawn in screen space) ----
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (S.phase === 'wave') {
      const frac = S.waveDuration > 0 ? S.waveTimeLeft / S.waveDuration : 0;
      ctx.fillStyle = 'rgba(11, 21, 25, 0.55)';
      ctx.fillRect(0, (v.h || 500) - 6, (v.w || 700) * frac, 3);
      ctx.fillStyle = frac > 0.3 ? '#38BDF8' : '#EF4444';
      ctx.fillRect(0, (v.h || 500) - 6, (v.w || 700) * frac, 3);
    } else if (S.phase === 'briefing') {
      ctx.fillStyle = 'rgba(245, 158, 11, 0.85)';
      ctx.font = '700 11px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('DIRECTIVE INBOUND - ' + Math.ceil(S.briefingT) + 's', (v.w || 700) / 2, 18);
    }
    ctx.restore();
  },

  /* Pointer handlers. `pt` is expected in corridor map coordinates
     ({ x, y }); main.js projects client -> map via toMap(). Right-click
     (ev.button === 2) triggers the Containment Burst at the cursor. */
  onPointerDown(pt, ev) {
    const p = normPt(pt);
    if (!p) return;
    S.lastPt = p;
    const button = ev && typeof ev.button === 'number' ? ev.button : 0;

    if (button === 2) { // right-click: Containment Burst
      if (S.phase === 'wave') { triggerSprayBurst(p); if (ev && ev.preventDefault) ev.preventDefault(); }
      return;
    }

    if (S.phase === 'plan') {
      const G = getG();
      const hit = districtAt(p.x, p.y, G ? G.districts : []);
      if (hit) {
        S.selectedId = hit.id;
        if (G) { G.selected = hit.id; setG(G); }
        SFX.play('tap');
      }
      return;
    }

    if (S.phase === 'wave') {
      S.pointerActive = true;
      S.trail = [{ x: p.x, y: p.y, t: nowMs() }];
      swatSegment(p.x, p.y, p.x, p.y, false);
    }
  },

  onPointerMove(pt, ev) {
    const p = normPt(pt);
    if (!p) return;
    const prev = S.lastPt;
    S.lastPt = p;
    if (!S.pointerActive || S.phase !== 'wave') return;
    S.trail.push({ x: p.x, y: p.y, t: nowMs() });
    if (S.trail.length > 24) S.trail.shift();
    if (prev) swatSegment(prev.x, prev.y, p.x, p.y, true);
  },

  onPointerUp(pt, ev) {
    const p = normPt(pt);
    if (p) S.lastPt = p;
    S.pointerActive = false;
  },

  onKeyDown(ev) {
    if (!ev) return;
    const key = ev.key;
    const lower = typeof key === 'string' ? key.toLowerCase() : '';

    if (lower === 'p' || key === 'Escape') {
      if (S.active) S.paused = !S.paused;
      const G = getG(); if (G) { G.paused = S.paused; setG(G); }
      if (ev.preventDefault) ev.preventDefault();
      return;
    }
    if (key === ' ' || lower === 'spacebar') {
      if (S.phase === 'wave') triggerSprayBurst(S.lastPt);
      else if (S.phase === 'plan') commitDeployment();
      else if (S.phase === 'report') continueFromReport();
      if (ev.preventDefault) ev.preventDefault();
      return;
    }
    if (key === 'Enter') {
      if (S.phase === 'plan') commitDeployment();
      else if (S.phase === 'report') continueFromReport();
      if (ev.preventDefault) ev.preventDefault();
      return;
    }
    if (lower === 'w') {
      if (S.phase === 'wave') buySurgeWard();
      return;
    }
    if (lower === 'a') {
      // REPORT phase: dispatch the EpiKD audit pill event (keyboard affordance)
      if (S.phase === 'report') {
        dispatch('dd:open-epikd-audit', {
          monthLabel: S.report ? S.report.monthLabel : null,
          monthIndex: S.monthIndex,
          scenario: S.scenario,
          doctrine: S.doctrine,
          report: S.report ? { ...S.report } : null,
        });
        SFX.play('tap');
      }
      return;
    }
    // Protocol hotkeys in PLAN: 1 PSN, 2 Ovitraps, 3 Fog, 4 Ward, 5 Sweep
    if (S.phase === 'plan' && ['1', '2', '3', '4', '5'].includes(key)) {
      const map = { 1: 'psn', 2: 'traps', 3: 'fog', 4: 'clinic', 5: 'ping' };
      toggleProtocol(map[key]);
      return;
    }
    // Perk hotkeys: 1-3 choose
    if (S.phase === 'perk' && ['1', '2', '3'].includes(key)) {
      const idx = Number(key) - 1;
      const perkId = S.perkChoices[idx];
      if (perkId) choosePerk(perkId);
    }
  },

  /* getHudSnapshot(): plain JSON-able HUD descriptor. The shell (js/ui/hud.js)
     renders exclusively from this object + the dd:* events. */
  getHudSnapshot() {
    const G = getG();
    const W = getW();
    const M = currentMonth();
    const cap = hospitalCap();
    const load = G ? (G.hospitalLoad || 0) : 0;
    const districts = (G && Array.isArray(G.districts)) ? G.districts.map(d => {
      const pred = districtPrediction(d);
      const revealed = !!d.revealed || (S.campaignMods.revealAllMonths || 0) > 0;
      return {
        id: d.id,
        name: d.name,
        risk: districtRisk(d),
        riskName: RISK_IDS[districtRisk(d)],
        mitigationPct: Math.round(d.mitigationShown != null ? d.mitigationShown : mitigationFor(d)),
        revealed,
        radar: !!d.radar,
        predMedian: pred.median,
        predLow: pred.low,
        predHigh: pred.high,
        cases: Math.round(d.cases || 0),
        pools: d.pools || 0,
        protos: d.proto ? { ...d.proto } : { psn: false, traps: false, fog: false, clinic: false },
        selected: d.id === S.selectedId,
      };
    }) : [];
    const threatTier = districts.reduce((m, d) => Math.max(m, d.risk), 0);
    const waveRemaining = S.phase === 'wave' ? (S.mosq.length + S.queue.length) : 0;
    const snapshot = {
      phase: S.phase,
      paused: S.paused,
      monthIndex: absoluteMonthIndex(),
      monthPos: S.monthIndex,
      monthTotal: S.months.length,
      monthLabel: M ? M.m : 'NOV',
      monthName: M ? M.name : '',
      monthCounter: (S.monthIndex + 1) + ' / ' + S.months.length,
      funds: G ? Math.round(G.budget || 0) : 0,
      icuLoad: Math.round(load),
      icuCap: cap,
      icuPct: cap > 0 ? Math.round((load / cap) * 100) : 0,
      threatTier,
      scenario: S.scenario,
      scenarioName: S.scenarioDef && S.scenarioDef.name ? (S.scenarioDef.name[getLang()] || S.scenarioDef.name.en) : S.scenario,
      doctrine: S.doctrine,
      score: G ? (G.score || 0) : 0,
      combo: S.combo,
      comboMult: comboMult(),
      comboWindow: S.comboWindow,
      sprayCharge: Math.round(S.sprayCharge),
      sprayReady: S.sprayCharge >= 100,
      sprayRadiusPx: SPRAY_RADIUS_PX,
      directives: S.shocks.map(s => ({
        id: s.id, type: s.type,
        label: s.type ? trOr(`mode1.shock.${s.type}`, s.label) : s.label,
        district: s.district,
        revealed: !!s.revealed, timing: s.timing,
      })),
      directive: S.phase === 'briefing' ? localizeDirective(S.directive) : null,
      selectedDistrict: S.selectedId,
      districts,
      waveTimeLeft: Math.max(0, Math.round(S.waveTimeLeft * 10) / 10),
      waveDuration: S.waveDuration,
      waveRemaining,
      waveTotal: S.waveTotal,
      waveSpawned: S.waveSpawned,
      bites: S.bites,
      pressure: Math.round(S.pressure),
      surgeWardAvailable: S.phase === 'wave' && !S.surgeUsed && ((G && G.budget) || 0) >= SURGE_WARD_COST,
      surgeWardCost: SURGE_WARD_COST,
      surgeWardRelief: SURGE_WARD_RELIEF,
      pingCost: pingCost(),
      freeRiskAudits: G ? (G.freeRiskAudits || 0) : 0,
      protocolCosts: {
        psn: protocolCost('psn'), traps: protocolCost('traps'), fog: protocolCost('fog'),
        clinic: protocolCost('clinic'), ping: pingCost(),
      },
      mutators: G && Array.isArray(G.mutators) ? G.mutators.slice() : [],
      trust: G ? Math.round(G.trust || 0) : 0,
      report: S.report ? { ...S.report, districts: (S.report.districts || []).map(r => ({ ...r })) } : null,
      perkChoices: S.phase === 'perk'
        ? S.perkChoices.map(id => {
            const p = PERKS.find(x => x.id === id);
            return {
              id,
              name: trOr(`mode1.perk.${id}.name`, p ? p.name : id),
              desc: trOr(`mode1.perk.${id}.desc`, p ? p.desc : ''),
            };
          })
        : [],
      casesPrevented: S.casesPrevented,
      swatted: S.swatted,
      poolsDrained: S.poolsDrained,
      peakHeadroom: S.peakHeadroom,
      cleanMonths: S.cleanMonths,
      result: S.result,
      scorePenaltyMult: S.scorePenaltyMult,
      lengthFactor: scenarioLengthFactor(S.months.length || 6),
    };
    // Expose for E2E debugging parity (read-only usage expected)
    if (isBrowser()) { try { window.__operationsHud = snapshot; } catch (e) { /* ignore */ } }
    return snapshot;
  },
};

/* pt may arrive as map coords ({x, y} in corridor space), as explicit
   {mapX, mapY}, or as raw screen/client pixels (x or y beyond the corridor
   bounds) in which case we project back through the shared view. */
function normPt(pt) {
  if (!pt || typeof pt !== 'object') return null;
  if (Number.isFinite(pt.mapX) && Number.isFinite(pt.mapY)) return { x: pt.mapX, y: pt.mapY };
  if (Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
    if (pt.x > CORRIDOR.WIDTH || pt.y > CORRIDOR.HEIGHT || pt.x < 0 || pt.y < 0) {
      try {
        const [mx, my] = toMap(pt.x, pt.y);
        if (Number.isFinite(mx) && Number.isFinite(my)) return { x: mx, y: my };
      } catch (e) { /* fall through to raw values */ }
    }
    return { x: pt.x, y: pt.y };
  }
  return null;
}

export { OperationsMode };
export default OperationsMode;
