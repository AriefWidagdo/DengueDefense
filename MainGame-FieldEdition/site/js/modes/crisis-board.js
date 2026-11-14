/* Dengue Defense - Field Edition: Mode 2, Crisis Board (pure turn-based strategy).
   8 weekly turns x 3 sub-phases (INTEL BRIEFING -> COMMAND ALLOCATION -> WEEKLY RESOLUTION).
   No reflex/swat gameplay whatsoever: the map is a strategic crisis board. Canvas is used
   only for the corridor map, telegraphed threat arrows and pulse/lock cues; all command
   actions are AP-based and fully telegraphed with a live Into-the-Breach-style dry-run
   preview before resolution.

   Determinism: everything derives from the run seed via mulberry32 (state.js) and the
   offline EpiKD model (epi-engine.js). No DOM access at import time; window/document
   usage is guarded so the module imports cleanly in bare node.

   Owned by the Mode 2 build (W2-B). Do not import from other modes. */
import { EpiRuntime, DISTRICT_DEFS, RIVERS, districtAt, riskOf } from '../epi-engine.js';
import { MODEL_DATA } from '../epi-data.js';
import {
  GAME_RULES,
  MUTATORS,
  mulberry32,
  parseSeed,
  freshState,
  getG,
  SCENARIOS,
} from '../state.js';
import {
  drawMapBackground,
  drawMerapiContour,
  drawRiverCurves,
  drawDistrictPolygon,
  drawQuarantineEdge,
  drawUnitMarker,
  drawHotspotNode,
} from '../sprites.js';
import { getView, CORRIDOR } from '../map-renderer.js';
import { SFX } from '../audio.js';
import { t } from '../i18n.js';

/* ============================================================
   Tunables & static content
   ============================================================ */
const TOTAL_WEEKS = 8;
const BASE_AP = 3;
const MAX_AP = 4;
const AP_CARRYOVER_CAP = 1;
const BASE_DECAY = 18;               // base weekly discharge / bed recovery
const TRIAGE_DISCHARGE_BOOST = 14;   // extra discharges while a Clinic Surge is active
const ADMISSION_RATE = 0.22;         // share of active cases admitted per week
const TRANSMISSION = 1.12;           // untreated weekly transmission multiplier (monsoon compounding)
const MU_SEED = 0.10;                // background imported infection pressure scaled by the EpiKD mean
const COLLAPSE_ADMISSIONS = 25;      // extra admissions per uncontained district
const CORDON_BLOCK = 0.85;           // 85% spillover blocked
const CORDON_WEEKS = 2;
const LARVICIDE_REDUCTION = 0.35;
const OVITRAP_REDUCTION = 0.22;
const MITIGATION_STACK_CAP = 0.50;   // larvicide + ovitrap combined hard cap
const DEEP_INTEL_MITIGATION = 0.15;
const MASS_FOG_PRIMARY = 0.55;
const MASS_FOG_NEIGHBOR = 0.25;
const MASS_FOG_COOLDOWN = 2;         // available again 2 weeks after the cast
const MASS_FOG_ECO_PENALTY = 150;
const ECO_CLEAN_BONUS = 600;         // awarded when massFogUses <= 1
const SCORING = Object.freeze({ spillover: 160, icuHeadroom: 20, charge: 150, cleanWeek: 500 });
const HOSPITAL_REASON = 'hospital';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = v => clamp(Number.isFinite(v) ? v : 0, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOut = t => 1 - Math.pow(1 - t, 3);

/* Weekly event deck: 12 twists, dealt seed-deterministically (shuffled at init). */
const EVENT_DEFS = Object.freeze([
  { id: 'monsoon_cloudburst',   name: 'Monsoon Cloudburst',
    desc: 'Orographic rain cell over the corridor. Larval habitat pressure rises across all six regencies.',
    effect: 'All district growth pressure +15% this resolution.',
    growthMult: 1.15 },
  { id: 'school_term_opening',  name: 'School Term Opening',
    desc: 'Semester begins; student commuters surge along the rail and road corridors.',
    effect: 'Commuter spillover flows +25% this resolution.',
    flowMult: 1.25 },
  { id: 'bengawan_silting',     name: 'Bengawan Silting',
    desc: 'Siltation of the Bengawan Solo backwaters creates stagnant breeding channels.',
    effect: 'Biolarvicide effectiveness halved this resolution.',
    larvEffectivenessMult: 0.5 },
  { id: 'bio_control_shipment', name: 'Bio-Control Shipment',
    desc: 'A Wolbachia-adjacent release stock arrives from the regional lab.',
    effect: '+1 AP available this week.',
    apDelta: 1 },
  { id: 'ambulance_convoy',     name: 'Regional Ambulance Convoy',
    desc: 'Neighboring regencies dispatch surge ambulances to relieve ward pressure.',
    effect: 'Hospital load -20 immediately at resolution.',
    loadDelta: -20 },
  { id: 'mild_cluster',         name: 'Undiagnosed Mild Cluster',
    desc: 'Syndrome surveillance flags two running clusters with atypical presentation.',
    effect: 'Two highest-pressure districts gain +12 active cases at resolution.',
    mildClusterCases: 12 },
  { id: 'market_fair',          name: 'Cross-Regency Market Fair',
    desc: 'A rotating trade fair floods the corridor with inbound foot traffic.',
    effect: 'Commuter spillover flows +35% this resolution.',
    flowMult: 1.35 },
  { id: 'volunteer_3m_surge',   name: 'Volunteer 3M Surge',
    desc: 'Jumantik kader volunteers mobilize for a sweeping household clean-up weekend.',
    effect: 'All districts gain +10% mitigation this resolution.',
    mitigationDelta: 0.10 },
  { id: 'ward_power_outage',    name: 'Ward Power Outage',
    desc: 'Grid instability cuts auxiliary power to triage wards across the region.',
    effect: 'Admissions +25% and Clinic Surge beds are nullified this resolution.',
    admissionsMult: 1.25, triageNullified: true },
  { id: 'drought_stagnation',   name: 'Drought Stagnation Pools',
    desc: 'A rainless stretch pools stagnant water in low-lying settlements.',
    effect: 'District growth pressure +10%; commuter flows -25% this resolution.',
    growthMult: 1.10, flowMult: 0.75 },
  { id: 'rapid_test_drop',      name: 'Rapid Test Kit Drop',
    desc: 'A pallet of rapid NS1 kits lands at the command post. Results within the hour.',
    effect: 'The next 2 weeks of event modifiers are revealed immediately.',
    revealWeeks: 2 },
  { id: 'cold_front_recovery',  name: 'Early Cold Front Recovery',
    desc: 'An early dry, cool front suppresses vector activity across the corridor.',
    effect: 'District growth pressure -18%; +5% mitigation this resolution.',
    growthMult: 0.82, mitigationDelta: 0.05 },
]);

const ACTION_DEFS = Object.freeze([
  { id: 'cordon',      key: '1', name: 'CORDON',    fullName: 'Border Cordon',       apCost: 1, target: 'border',
    desc: 'Hazard line on a shared border. Blocks 85% spillover for 2 weeks. Max 2 active (3 Rapid Response).' },
  { id: 'larvicide',   key: '2', name: 'LARVICIDE', fullName: 'Biolarvicide Blitz',  apCost: 1, target: 'district',
    desc: '-35% district growth multiplier for 2 weeks (3 with Bio-Control Taskforce).' },
  { id: 'ovitrap_net', key: '3', name: 'OVITRAP',   fullName: 'Ovitrap Grid',        apCost: 1, target: 'district',
    desc: '-22% cases/week for 3 weeks. Stacks with larvicide up to the 50% cap.' },
  { id: 'ward_triage', key: '4', name: 'TRIAGE',    fullName: 'Emergency Ward Surge', apCost: 1, target: 'global',
    desc: '+85 regional beds for 2 weeks and -24 fever load now (+110 / -30 Rapid Response).' },
  { id: 'mass_fog',    key: '5', name: 'MASS FOG',  fullName: 'Sector Fogging',      apCost: 2, target: 'district_plus_neighbor',
    desc: '-55% active cases in target, -25% in one chosen neighbor. 2-week cooldown. -150 eco.' },
  { id: 'deep_intel',  key: '6', name: 'DEEP INTEL', fullName: 'Deep Surveillance',  apCost: 0, target: 'district',
    desc: 'Reveal the next 2 weeks of modifiers and grant +15% mitigation accuracy for 2 weeks. 0 AP.' },
]);
const ACTION_MAP = Object.freeze(Object.fromEntries(ACTION_DEFS.map(a => [a.id, a])));

const EVENT_I18N_KEY = Object.freeze({
  monsoon_cloudburst: 'monsoon_cloudburst',
  school_term_opening: 'school_term',
  bengawan_silting: 'bengawan_silting',
  bio_control_shipment: 'bio_shipment',
  ambulance_convoy: 'ambulance_convoy',
  mild_cluster: 'mild_cluster',
  market_fair: 'market_fair',
  volunteer_3m_surge: 'volunteer_surge',
  ward_power_outage: 'power_outage',
  drought_stagnation: 'drought_pools',
  rapid_test_drop: 'rapid_tests',
  cold_front_recovery: 'cold_front',
});

const ACTION_I18N_KEY = Object.freeze({
  cordon: 'quarantine',
  larvicide: 'larvicide',
  ovitrap_net: 'ovitraps',
  ward_triage: 'wardSurge',
  mass_fog: 'massFog',
  deep_intel: 'surveillance',
});

function trOr(key, fallback) {
  const val = t(key);
  return val && val !== key ? val : fallback;
}

function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ============================================================
   Border geometry: precomputed midpoints + tangent angles for
   every valid undirected adjacency pair from DISTRICT_DEFS.
   ============================================================ */
export function computeBorderEdges(defs = DISTRICT_DEFS) {
  const byId = Object.fromEntries(defs.map(d => [d.id, d]));
  const seen = new Set();
  const edges = [];
  for (const d of defs) {
    for (const nb of (d.nb || [])) {
      const a = byId[d.id], b = byId[nb];
      if (!a || !b) continue;
      const key = [d.id, nb].sort().join('<->');
      if (seen.has(key)) continue;
      seen.add(key);
      const ax = a.c[0], ay = a.c[1], bx = b.c[0], by = b.c[1];
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const axisAngle = Math.atan2(by - ay, bx - ax);
      const tangentAngle = axisAngle + Math.PI / 2;
      const len = 96;
      const hx = Math.cos(tangentAngle) * (len / 2), hy = Math.sin(tangentAngle) * (len / 2);
      edges.push({
        id: key,
        a: d.id,
        b: nb,
        mid: [mx, my],
        axisAngle,
        tangentAngle,
        length: len,
        seg: [[mx - hx, my - hy], [mx + hx, my + hy]],
      });
    }
  }
  return edges;
}

/* ============================================================
   CrisisBoardMode
   ============================================================ */
export const CrisisBoardMode = {
  id: 'crisis_board',
  supportsPause: true,
  usesRealTimeCanvasLoop: true,

  /* ---------- lifecycle ---------- */

  init({ seedStr, seed, doctrine, scenario, mutators } = {}) {
    this.dispose();
    const seedText = seedStr != null ? String(seedStr) : String(seed ?? 'CRISIS-BOARD');
    const numericSeed = Number.isFinite(seed) ? (seed >>> 0) : parseSeed(seedText);
    this.seedStr = seedText;
    this.seed = numericSeed;
    this.doctrine = DOCTRINE_IDS.has(doctrine) ? doctrine : null;
    this.scenario = scenario || 'regional_board';
    this.mutators = Array.isArray(mutators) ? mutators.slice() : [];
    this.mutatorMult = this.mutators.reduce((m, id) => {
      const def = MUTATORS.find(x => x.id === id);
      return m * (def ? def.mult : 1);
    }, 1);

    // Shared campaign state (window.G mirror kept for E2E hooks).
    let G = null;
    try {
      G = freshState(seedText, this.mutators, { mode: 'crisis_board', doctrine: this.doctrine, scenario: 'regional_board' });
    } catch (err) {
      G = getG();
    }
    this.G = G;

    // Deterministic streams.
    this.rng = mulberry32(this.seed ^ 0xC215_0B07);
    this.eventDeck = shuffle(EVENT_DEFS, mulberry32(this.seed ^ 0x51ED_9A3B));

    // District runtime state (mutate the shared freshState districts so window.G sees live values).
    const districtSource = (G && Array.isArray(G.districts) && G.districts.length)
      ? G.districts
      : DISTRICT_DEFS.map(def => ({ ...def, c: def.c.slice(), nb: def.nb.slice(), cases: 20, pools: 6, referencePools: 6, poly: null, bb: null, path: null, epi: null, outlook: null }));
    this.districts = districtSource;
    this.districtById = Object.fromEntries(this.districts.map(d => [d.id, d]));
    for (const d of this.districts) {
      d.endemicThreshold = (d.epi && Number.isFinite(d.epi.threshold) && d.epi.threshold > 0) ? d.epi.threshold : 100;
      d.larvicideUntil = 0;
      d.ovitrapUntil = 0;
      d.deepIntelUntil = 0;
      d.fogFlash = 0;
      d.inflow = 0;
      this._recomputeDistrictIntel(d);
    }

    // Hospital model.
    const doctrineDef = this.doctrine;
    this.hospitalCap = (G && Number.isFinite(G.hospitalCap)) ? G.hospitalCap : GAME_RULES.careSlots;
    this.hospitalLoad = 40;
    this.triageSurges = [];       // [{ untilWeek, amount }]
    this.triageDischargeBoost = 0;

    // Command economy.
    this.week = 1;
    this.ap = BASE_AP;
    this.maxAp = MAX_AP;
    this.carryover = 0;
    this.cordons = [];            // [{ id, edgeId, a, b, weeksLeft }]
    this.cordonMax = doctrineDef === 'rapid_response_corps' ? 3 : 2;
    this.deepIntelCharges = 2 + (doctrineDef === 'surveillance_directorate' ? 1 : 0);
    this.deepIntelBonusGranted = { 1: false, 5: false };
    this.massFogUses = 0;
    this.fogReadyWeek = 1;
    this.spilloverBlockedTotal = 0;
    this.cleanWeeks = 0;
    this.score = 0;
    this.scoreParts = null;

    // Board UI / interaction state.
    this.phase = 'intel';         // 'intel' | 'allocate' | 'resolution' | 'over'
    this.result = null;           // null | 'win' | 'loss'
    this.lossReason = null;
    this.selectedAction = null;
    this.selectedDistrict = this.districtById['klaten'] ? 'klaten' : this.districts[0].id;
    this.pendingFogPrimary = null; // district id awaiting neighbor pick
    this.hoverDistrict = null;
    this.hoverBorder = null;
    this.paused = false;
    this.disposed = false;
    this.gameOverFired = false;
    this.message = 'INTEL BRIEFING: review threat vectors, then press ENTER to allocate.';
    this.messageUntil = 6;
    this._nowSec = 0;
    this._view = null;
    this._buttons = [];
    this._arrows = [];
    this._resT = 0;
    this._resOutcome = null;
    this._loadAnimFrom = this.hospitalLoad;
    this._loadAnimTo = this.hospitalLoad;
    this.revealedThrough = 0;     // event cards for weeks <= this are pre-revealed
    this.currentEvent = null;
    this.nextEvent = null;

    // Scenario climate overlay (regional_board has no SCENARIOS row -> baseline).
    const scenarioDef = SCENARIOS.find(s => s.id === this.scenario) || null;
    const climateId = scenarioDef && scenarioDef.climateProfile ? scenarioDef.climateProfile : 'baseline';
    const climateTable = {
      baseline: { mu: 1.00, flow: 1.00 },
      el_nino_drought: { mu: 0.88, flow: 0.95 },
      monsoon_surge: { mu: 1.18, flow: 1.08 },
      urban_commuter: { mu: 1.12, flow: 1.45 },
    };
    this.climate = climateTable[climateId] || climateTable.baseline;

    // Border adjacency graph (precomputed geometry).
    this.edges = computeBorderEdges(DISTRICT_DEFS);
    this.edgeById = Object.fromEntries(this.edges.map(e => [e.id, e]));

    this._model = null;
    this._beginWeek();
    this._recomputePreview();
    return this;
  },

  dispose() {
    this.disposed = true;
    this.paused = false;
    this.phase = 'over';
    this.result = null;
    this._buttons = [];
    this._arrows = [];
    this._resOutcome = null;
    this.cordons = [];
    this.triageSurges = [];
    if (this.rng) this.rng = null;
    return this;
  },

  /* ---------- per-frame update ---------- */

  update(dt, now) {
    if (this.disposed) return;
    const raw = Number.isFinite(dt) ? dt : 0;
    const sec = raw > 1 ? raw / 1000 : raw; // tolerate ms or seconds
    this._nowSec = (Number.isFinite(now) ? now : this._nowSec * 1000 + raw * 1000) / 1000;
    if (this.messageUntil > 0) this.messageUntil -= sec;
    if (this.paused) return;
    if (this.phase === 'resolution') {
      this._resT += sec;
      if (this._resT >= 1.7) this._endResolution();
    }
  },

  /* ---------- rendering ---------- */

  render(ctx, view, now) {
    if (!ctx) return;
    const fallback = safeGetView();
    const v = (view && Number.isFinite(view.w)) ? Object.assign(fallback, view) : fallback;
    this._view = v;
    const time = (Number.isFinite(now) ? now : 0) / 1000;
    this._nowSec = time;
    const dpr = v.dpr || 1;
    const districts = this.districts || [];

    // Pass 1: screen-space background.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.w, v.h);
    try { drawMapBackground(ctx, Object.assign({}, v, { time })); } catch (err) { /* headless */ }

    // Pass 2: map space (corridor letterboxed).
    ctx.setTransform(
      dpr * v.scale, 0, 0, dpr * v.scale,
      dpr * (v.ox - CORRIDOR.MX0 * v.scale),
      dpr * (v.oy - CORRIDOR.MY0 * v.scale),
    );
    ctx.lineWidth = 1 / Math.max(v.scale, 0.01);

    try { drawMerapiContour(ctx, { time }); } catch (err) { /* non-fatal */ }
    try { drawRiverCurves(ctx, RIVERS, time); } catch (err) { /* non-fatal */ }

    // Subtle scan sweep cue (purely cosmetic, no gameplay meaning).
    this._drawScanSweep(ctx, time);

    // Districts: risk choropleth + tactical selection.
    for (const d of districts) {
      try {
        drawDistrictPolygon(ctx, Object.assign({}, d, { risk: d.riskIndex, selected: d.id === this.selectedDistrict }), { time, selected: d.id === this.selectedDistrict });
      } catch (err) { /* headless: skip */ }
    }

    // Net spillover flow arrows (preview-aware: update live as actions are queued).
    this._drawFlows(ctx, time);

    // Active cordons (hazard chevrons) + clickable border lock nodes.
    this._drawBorderNodes(ctx, time);

    // Pulsing surveillance hotspots on pressured districts.
    for (const d of districts) {
      if (d.threat >= 30) {
        try {
          drawHotspotNode(ctx, d.c[0], d.c[1], {
            time,
            color: d.threat >= 60 ? '#EF4444' : '#F59E0B',
            intensity: clamp(d.threat / 100, 0.2, 1),
          });
        } catch (err) { /* headless */ }
      }
    }

    // Intervention markers (larvicide ~ psn token, ovitrap ~ traps token).
    for (const d of districts) {
      if (this.week <= d.larvicideUntil) {
        try { drawUnitMarker(ctx, d.c[0] - 18, d.c[1] + 14, 'psn', { time, active: true }); } catch (err) { /* headless */ }
      }
      if (this.week <= d.ovitrapUntil) {
        try { drawUnitMarker(ctx, d.c[0] + 18, d.c[1] + 14, 'traps', { time, active: true }); } catch (err) { /* headless */ }
      }
    }

    this._drawDistrictMicro(ctx, time);
    if (this.phase === 'resolution') this._drawResolutionCues(ctx, time);

    // Pass 3: screen-space UI chrome.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._buttons = [];
    this._drawTopStrip(ctx, v, time);
    this._drawEventCard(ctx, v, time);
    this._drawPreviewPanel(ctx, v, time);
    this._drawActionBar(ctx, v, time);
    this._drawPhaseControl(ctx, v, time);
    this._drawMessage(ctx, v, time);
    if (this.phase === 'over') this._drawOverOverlay(ctx, v, time);
    if (this.paused) this._drawCenterTag(ctx, v, 'PAUSED - PRESS P TO RESUME');
  },

  /* ---------- pointer handling ---------- */

  _points(pt, ev) {
    // Single source of truth for pointer coordinates. Browser events carry
    // clientX/clientY which unambiguously identify the screen point; without
    // an event we honor the adapter contract and treat pt as map coordinates.
    const v = this._view || safeGetView();
    const scale = Math.max(0.01, v.scale || 1);
    if (ev && Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)) {
      const rect = (ev.target && typeof ev.target.getBoundingClientRect === 'function') ? ev.target.getBoundingClientRect() : { left: 0, top: 0 };
      const sx = ev.clientX - (rect.left || 0), sy = ev.clientY - (rect.top || 0);
      return { mx: (sx - v.ox) / scale + CORRIDOR.MX0, my: (sy - v.oy) / scale + CORRIDOR.MY0, sx, sy };
    }
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
    return { mx: pt.x, my: pt.y, sx: v.ox + (pt.x - CORRIDOR.MX0) * scale, sy: v.oy + (pt.y - CORRIDOR.MY0) * scale };
  },

  onPointerDown(pt, ev) {
    const p = this._points(pt, ev);
    if (!p) return null;

    // 1) UI buttons (screen space).
    const btn = this._hitButton(p.sx, p.sy);
    if (btn) { this._onButton(btn.id); return { consumed: true, button: btn.id }; }
    if (this.phase === 'over') return { consumed: false };

    // 2) Map interactions (map space): border lock nodes win over districts.
    const edge = this._nearestBorder(p.mx, p.my, 22);
    if (edge && this.phase === 'allocate') { this._toggleCordon(edge); return { consumed: true, edge: edge.id }; }
    const d = districtAt(p.mx, p.my, this.districts);
    if (d) { this._onDistrictClick(d); return { consumed: true, district: d.id }; }
    if (edge) { this._setMessage('ENTER COMMAND ALLOCATION TO PLACE CORDONS', 2.5); return { consumed: true, edge: edge.id }; }
    return { consumed: false };
  },

  onPointerMove(pt, ev) {
    const p = this._points(pt, ev);
    if (!p) return null;
    const hoverE = this._nearestBorder(p.mx, p.my, 22);
    const hoverD = hoverE ? null : districtAt(p.mx, p.my, this.districts);
    const changed = (hoverD && hoverD.id) !== this.hoverDistrict || (hoverE && hoverE.id) !== this.hoverBorder;
    this.hoverDistrict = hoverD ? hoverD.id : null;
    this.hoverBorder = hoverE ? hoverE.id : null;
    if (changed) this._recomputePreview();
    return { district: this.hoverDistrict, edge: this.hoverBorder };
  },

  onPointerUp(pt, ev) {
    return { consumed: false };
  },

  onKeyDown(ev) {
    if (!ev) return null;
    const key = String(ev.key || '').toLowerCase();
    if (key === 'p') { this.paused = !this.paused; this._setMessage(this.paused ? 'PAUSED' : 'RESUMED', this._nowSec + 2); return { consumed: true, paused: this.paused }; }
    if (key === 'escape') {
      if (this.pendingFogPrimary) { this.pendingFogPrimary = null; this._setMessage('FOG TARGET CANCELLED', 2); this._recomputePreview(); return { consumed: true }; }
      if (this.selectedAction) { this.selectedAction = null; this._setMessage('ACTION DESELECTED', 2); this._recomputePreview(); return { consumed: true }; }
      return { consumed: false };
    }
    const action = ACTION_DEFS.find(a => a.key === key);
    if (action && (this.phase === 'allocate' || this.phase === 'intel')) { this._selectAction(action.id); return { consumed: true, action: action.id }; }
    if (key === 'enter' || key === ' ' || key === 'e') {
      if (this.phase === 'intel') { this._beginAllocation(); return { consumed: true }; }
      if (this.phase === 'allocate') { this._resolveWeek(); return { consumed: true }; }
      return { consumed: false };
    }
    return { consumed: false };
  },

  /* ---------- HUD snapshot ---------- */

  getHudSnapshot() {
    const g = this.G || getG() || {};
    const week = this.week || 1;
    const districts = (this.districts || []).map(d => ({
      id: d.id,
      name: d.name || String(d.id || '').toUpperCase(),
      threat: d.threat,
      median: Math.round(d.median),
      q25: Math.round(d.q25),
      q75: Math.round(d.q75),
      exceedRisk: Number((d.exceedRisk || 0).toFixed(3)),
      activeTx: Math.round(d.cases),
      mitigationPct: Math.round(this._districtMitigation(d, week, null) * 100),
      endemicThreshold: Math.round(d.endemicThreshold),
      collapsed: d.cases >= 3 * d.endemicThreshold,
      larvicideWeeksLeft: Math.max(0, d.larvicideUntil - week + 1),
      ovitrapWeeksLeft: Math.max(0, d.ovitrapUntil - week + 1),
      deepIntelWeeksLeft: Math.max(0, d.deepIntelUntil - week + 1),
      riskIndex: d.riskIndex,
    }));
    const activeCordons = this.cordons.map(c => ({
      id: c.id, edge: c.edgeId, a: c.a, b: c.b, weeksLeft: c.weeksLeft, blockPct: Math.round(CORDON_BLOCK * 100),
    }));
    const actions = ACTION_DEFS.map(a => {
      const state = this._actionState(a);
      const ak = ACTION_I18N_KEY[a.id];
      return {
        id: a.id,
        name: ak ? trOr(`mode2.action.${ak}.name`, a.fullName) : a.fullName,
        shortName: ak ? trOr(`mode2.action.${ak}.short`, a.name) : a.name,
        desc: ak ? trOr(`mode2.action.${ak}.desc`, a.desc) : a.desc,
        apCost: a.apCost, target: a.target, key: a.key,
        cooldownReady: state.cooldownReady, disabledReason: state.disabledReason,
        chargesLeft: a.id === 'deep_intel' ? this.deepIntelCharges : undefined,
        selected: this.selectedAction === a.id,
      };
    });
    const effCap = this._effectiveCap();
    const flows = (this._arrows || []).map(f => ({ from: f.from, to: f.to, amount: f.amount, blocked: f.blocked || 0, applied: f.applied }));
    return {
      id: this.id,
      mode: 'crisis_board',
      leaderboardKey: 'crisis_board',
      phase: this.phase,
      week,
      totalWeeks: TOTAL_WEEKS,
      ap: this.ap,
      maxAp: this.maxAp,
      carryover: this.carryover,
      cordonActive: this.cordons.length,
      cordonMax: this.cordonMax,
      deepIntelCharges: this.deepIntelCharges,
      actions,
      districts,
      activeCordons,
      flows,
      preview: this.preview || null,
      hospitalLoad: Math.round(this._displayedLoad()),
      hospitalCap: this.hospitalCap,
      hospitalEffectiveCap: effCap,
      triageSurgeBeds: effCap - this.hospitalCap,
      eventCard: this.currentEvent ? (() => {
        const ek = EVENT_I18N_KEY[this.currentEvent.id];
        return {
          id: this.currentEvent.id,
          name: ek ? trOr(`mode2.event.${ek}.title`, this.currentEvent.name) : this.currentEvent.name,
          desc: ek ? trOr(`mode2.event.${ek}.flavor`, this.currentEvent.desc) : this.currentEvent.desc,
          effect: ek ? trOr(`mode2.event.${ek}.effect`, this.currentEvent.effect) : this.currentEvent.effect,
          week,
        };
      })() : null,
      nextEventCard: this._nextEventSnapshot(),
      score: Math.round(this.score || 0),
      scoreParts: this.scoreParts,
      result: this.result,
      lossReason: this.lossReason,
      massFogUses: this.massFogUses,
      cleanWeeks: this.cleanWeeks,
      spilloverBlocked: Math.round(this.spilloverBlockedTotal),
      selectedAction: this.selectedAction,
      selectedDistrict: this.selectedDistrict,
      hoverBorder: this.hoverBorder,
      pendingFogPrimary: this.pendingFogPrimary,
      paused: !!this.paused,
      message: (this.messageUntil > 0 ? this.message : ''),
      seedStr: this.seedStr,
      doctrine: this.doctrine,
      scenario: this.scenario,
      mutators: this.mutators.slice(),
      scoreMult: Number((this.mutatorMult || 1).toFixed(3)),
      totals: g && g.totals ? { ...g.totals } : undefined,
    };
  },
};

const DOCTRINE_IDS = new Set(['surveillance_directorate', 'biocontrol_taskforce', 'rapid_response_corps']);

function safeGetView() {
  try { return Object.assign({ w: 1280, h: 800, dpr: 1, scale: 1, ox: 0, oy: 0 }, getView()); }
  catch (err) { return { w: 1280, h: 800, dpr: 1, scale: 1, ox: 0, oy: 0 }; }
}

/* ============================================================
   Internal helpers (attached to the exported adapter object).
   Kept outside the literal so the lifecycle contract above stays
   readable; behavior is identical at call time.
   ============================================================ */

/* ============================================================
   Internal helpers (attached to the exported adapter object).
   Kept outside the literal so the lifecycle contract above stays
   readable; behavior is identical at call time.
   ============================================================ */
Object.assign(CrisisBoardMode, {

  /* ---------- small utilities ---------- */

  _sfx(name) {
    try { if (SFX && typeof SFX.play === 'function') SFX.play(name); } catch (err) { /* audio optional */ }
  },

  _setMessage(text, ttl = 3) {
    this.message = String(text || '');
    this.messageUntil = Math.max(0, ttl);
  },

  _districtMitigation(d, week, hyp) {
    const ev = this.currentEvent || null;
    const larvMult = (ev && ev.larvEffectivenessMult) ? ev.larvEffectivenessMult : 1;
    let larv = week <= d.larvicideUntil ? LARVICIDE_REDUCTION : 0;
    let ovi = week <= d.ovitrapUntil ? OVITRAP_REDUCTION : 0;
    if (hyp) {
      if (hyp.actionId === 'larvicide' && hyp.targetId === d.id) larv = LARVICIDE_REDUCTION;
      if (hyp.actionId === 'ovitrap_net' && hyp.targetId === d.id) ovi = OVITRAP_REDUCTION;
    }
    let m = larv * larvMult + ovi;
    if (m > MITIGATION_STACK_CAP) m = MITIGATION_STACK_CAP;
    if (week <= d.deepIntelUntil) m += DEEP_INTEL_MITIGATION;
    if (hyp && hyp.actionId === 'deep_intel' && hyp.targetId === d.id) m += DEEP_INTEL_MITIGATION;
    if (ev && ev.mitigationDelta) m += ev.mitigationDelta;
    return clamp(m, 0, 0.65);
  },

  _recomputeDistrictIntel(d) {
    const epi = d.epi || null;
    const mu = epi && Number.isFinite(epi.mu) ? epi.mu : Math.max(1, Number(d.cases) || 1);
    const kappa = epi && Number.isFinite(epi.kappa) && epi.kappa > 0 ? epi.kappa : 3;
    try {
      d.q25 = EpiRuntime.nbQuantile(0.25, mu, kappa);
      d.q75 = EpiRuntime.nbQuantile(0.75, mu, kappa);
    } catch (err) {
      d.q25 = Math.round(mu * 0.6);
      d.q75 = Math.round(mu * 1.4);
    }
    d.median = mu;
    d.exceedRisk = epi && Number.isFinite(epi.eventProb) ? clamp01(epi.eventProb) : 0;
    const thr = Number.isFinite(d.endemicThreshold) && d.endemicThreshold > 0 ? d.endemicThreshold : 100;
    d.riskIndex = riskOf(mu, thr);
    const collapse = (Number(d.cases) || 0) >= 3 * thr;
    d.threat = clamp(Math.round(65 * clamp(mu / (2 * thr), 0, 1) + 35 * d.exceedRisk + (collapse ? 25 : 0)), 0, 100);
  },

  _triageBeds(ev) {
    const evt = ev === undefined ? this.currentEvent : ev;
    if (evt && evt.triageNullified) return 0;
    return (this.triageSurges || [])
      .filter(s => s.untilWeek >= this.week)
      .reduce((sum, s) => sum + s.amount, 0);
  },

  _effectiveCap() {
    return this.hospitalCap + this._triageBeds(this.currentEvent);
  },

  _displayedLoad() {
    if (this.phase === 'resolution') {
      const t = clamp01((this._resT || 0) / 1.2);
      return Math.round(lerp(this._loadAnimFrom || 0, this._loadAnimTo || 0, easeInOut(t)));
    }
    return this.hospitalLoad;
  },

  /* ---------- week lifecycle ---------- */

  _beginWeek() {
    const week = this.week;
    // Surveillance Directorate: +1 Deep Surveillance charge on Weeks 1 and 5.
    if (this.doctrine === 'surveillance_directorate') {
      if (week === 1 && !this.deepIntelBonusGranted[1]) { this.deepIntelCharges += 1; this.deepIntelBonusGranted[1] = true; }
      if (week === 5 && !this.deepIntelBonusGranted[5]) { this.deepIntelCharges += 1; this.deepIntelBonusGranted[5] = true; }
    }
    // Refresh EpiKD forecasts for this turn's horizon.
    try {
      if (!this._model) this._model = EpiRuntime.create(MODEL_DATA);
      const history = (this.G && this.G.modelHistory) || {};
      const forecasts = this._model.predictAll(Math.min(week - 1, 6), history);
      for (const d of this.districts) {
        const f = forecasts[d.id];
        if (f && f.length && f[0]) {
          d.outlook = f;
          d.epi = f[0];
          if (Number.isFinite(f[0].threshold) && f[0].threshold > 0) d.endemicThreshold = f[0].threshold;
        }
      }
    } catch (err) { /* keep prior forecasts; board must stay playable offline */ }
    for (const d of this.districts) this._recomputeDistrictIntel(d);

    // Deal the weekly event twist (seed-deterministic deck).
    this.currentEvent = this.eventDeck[(week - 1) % this.eventDeck.length] || null;
    this.nextEvent = week < TOTAL_WEEKS ? (this.eventDeck[week % this.eventDeck.length] || null) : null;
    if (this.currentEvent && this.currentEvent.revealWeeks) {
      this.revealedThrough = Math.max(this.revealedThrough, week + this.currentEvent.revealWeeks - 1);
    }

    // Command economy: 3 AP + 1 carryover (max 4) + Bio-Control Shipment bonus.
    this.carryover = Math.min(AP_CARRYOVER_CAP, this.carryover || 0);
    this.ap = Math.min(this.maxAp, BASE_AP + this.carryover + ((this.currentEvent && this.currentEvent.apDelta) || 0));
    this.phase = 'intel';
  },

  _beginAllocation() {
    if (this.phase !== 'intel') return;
    this.phase = 'allocate';
    this._setMessage('COMMAND ALLOCATION: ' + this.ap + ' AP - keys 1-6 select, ENTER resolves', 4);
    this._sfx('tap');
    this._recomputePreview();
  },

  _resolveWeek() {
    if (this.phase !== 'allocate') return;
    this.phase = 'resolution';
    this._resT = 0;
    const week = this.week;
    const ev = this.currentEvent || {};
    const growth = (this.climate ? this.climate.mu : 1) * (ev.growthMult || 1);
    const flowMult = (this.climate ? this.climate.flow : 1) * (ev.flowMult || 1);

    // Week is committed: compute flows from current loads.
    const effLoad = {};
    for (const d of this.districts) effLoad[d.id] = d.cases;
    const flows = this._flowsFor(effLoad, flowMult, this.cordons);
    const inflow = {};
    for (const f of flows) inflow[f.to] = (inflow[f.to] || 0) + f.applied;
    if (ev.mildClusterCases) {
      const ranked = this.districts.slice().sort((a, b) => ((b.epi && b.epi.mu) || 0) - ((a.epi && a.epi.mu) || 0));
      for (const d of ranked.slice(0, 2)) inflow[d.id] = (inflow[d.id] || 0) + ev.mildClusterCases;
    }

    // Stochastic actuals around the projected means (seeded; deep intel tightens kappa).
    const actual = {};
    const proj = {};
    const cues = [];
    let totalActual = 0, collapseCount = 0;
    for (const d of this.districts) {
      const epi = d.epi || null;
      const mu0 = epi && Number.isFinite(epi.mu) ? epi.mu : d.cases;
      const kappa0 = epi && Number.isFinite(epi.kappa) && epi.kappa > 0 ? epi.kappa : 3;
      const mit = this._districtMitigation(d, week, null);
      const rMult = clamp(TRANSMISSION * growth * (1 - mit), 0.6, 1.6);
      const muAdj = Math.max(0.5, d.cases * rMult + (inflow[d.id] || 0) + mu0 * MU_SEED * (1 - mit));
      const kappaAdj = kappa0 * (week <= d.deepIntelUntil ? 1.35 : 1);
      let drawn = Math.round(muAdj);
      try { drawn = EpiRuntime.sample(muAdj, kappaAdj, this.rng); } catch (err) { /* deterministic fallback */ }
      drawn = Math.max(0, Math.round(drawn));
      actual[d.id] = drawn;
      proj[d.id] = Math.round(muAdj);
      totalActual += drawn;
      if (drawn >= 3 * d.endemicThreshold) collapseCount += 1;
    }
    const blockedThis = flows.reduce((s, f) => s + f.blocked, 0);
    this.spilloverBlockedTotal += blockedThis;

    const exceedRatio = this.districts.reduce((s, d) => s + clamp(actual[d.id] / (2 * d.endemicThreshold), 0, 2), 0) / this.districts.length;
    const admissions = Math.round(totalActual * ADMISSION_RATE * (1 + 0.35 * exceedRatio) * (ev.admissionsMult || 1)) + collapseCount * COLLAPSE_ADMISSIONS;
    const surgeBeds = this._triageBeds(ev);
    const discharges = BASE_DECAY + (surgeBeds > 0 ? TRIAGE_DISCHARGE_BOOST : 0) + (ev.dischargeDelta || 0);
    const loadBefore = this.hospitalLoad;
    const loadAfter = clamp(Math.round(loadBefore + admissions - discharges + (ev.loadDelta || 0)), 0, 9999);
    const effCap = this.hospitalCap + surgeBeds;

    // Commit district case counts; stage presentation cues.
    for (const d of this.districts) {
      const delta = actual[d.id] - d.cases;
      d.cases = actual[d.id];
      d.inflow = inflow[d.id] || 0;
      this._recomputeDistrictIntel(d);
      if (delta !== 0) {
        cues.push({
          x: d.c[0], y: d.c[1] - 8,
          text: (delta >= 0 ? '+' : '') + delta,
          color: delta >= 0 ? '#F87171' : '#34D399',
          at: 0.2 + this.rng() * 0.9,
        });
      }
    }
    const clean = collapseCount === 0
      && this.districts.every(d => d.cases < 2 * d.endemicThreshold)
      && loadAfter <= 0.75 * effCap;
    if (clean) this.cleanWeeks += 1;

    // Cordon upkeep (a cordon absorbs this resolution, then ages).
    for (const c of this.cordons) c.weeksLeft -= 1;
    this.cordons = this.cordons.filter(c => c.weeksLeft > 0);
    this.triageSurges = this.triageSurges.filter(s => s.untilWeek >= week);

    this.hospitalLoad = loadAfter;
    this._loadAnimFrom = loadBefore;
    this._loadAnimTo = loadAfter;
    this._resOutcome = {
      flows, proj, actual, cues, blockedThis, admissions, discharges,
      loadBefore, loadAfter, effCap, clean, totalActual, collapseCount,
    };
    this.selectedAction = null;
    this.pendingFogPrimary = null;
    this._sfx('wave');
    this._recomputePreview();
  },

  _endResolution() {
    const outcome = this._resOutcome;
    this._resT = 0;
    this._resOutcome = null;
    const ovCap = outcome ? outcome.effCap : this._effectiveCap();
    const collapsed = this.districts.some(d => d.cases >= 3 * d.endemicThreshold);
    if (this.hospitalLoad > ovCap) { this._gameOver('loss', HOSPITAL_REASON); return; }
    if (this.week >= TOTAL_WEEKS) {
      if (collapsed) { this._gameOver('loss', 'collapse'); return; }
      this._gameOver('win', null);
      return;
    }
    this.week += 1;
    this.carryover = Math.min(AP_CARRYOVER_CAP, this.ap);
    this._beginWeek();
    this._setMessage('WEEK ' + this.week + '/' + TOTAL_WEEKS + ' - INTEL BRIEFING', 4);
    this._recomputePreview();
  },

  _gameOver(result, reason) {
    this.phase = 'over';
    this.result = result;
    this.lossReason = reason || null;
    this.selectedAction = null;
    this.pendingFogPrimary = null;
    this._finalizeScore();
    this._fireGameOver(result === 'win' ? 'victory' : (reason || HOSPITAL_REASON));
    this._setMessage(result === 'win' ? 'CORRIDOR HELD - DEBRIEF READY' : 'REGION OVERWHELMED - DEBRIEF READY', 8);
    this._sfx(result === 'win' ? 'win' : 'lose');
  },

  _finalizeScore() {
    const effCap = this._effectiveCap();
    const icuHeadroom = Math.max(0, Math.round(effCap - this.hospitalLoad));
    const unspent = Math.max(0, this.deepIntelCharges | 0);
    const ecoClean = this.massFogUses <= 1;
    const spilloverScore = Math.round(this.spilloverBlockedTotal * SCORING.spillover);
    const headroomScore = icuHeadroom * SCORING.icuHeadroom;
    const chargeScore = unspent * SCORING.charge;
    const cleanScore = this.cleanWeeks * SCORING.cleanWeek;
    const ecoBonus = ecoClean ? ECO_CLEAN_BONUS : 0;
    const ecoPenalty = MASS_FOG_ECO_PENALTY * this.massFogUses;
    const mult = this.mutatorMult || 1;
    const base = spilloverScore + headroomScore + chargeScore + cleanScore + ecoBonus - ecoPenalty;
    this.score = Math.max(0, Math.round(base * mult));
    this.scoreParts = {
      spilloverBlocked: Math.round(this.spilloverBlockedTotal),
      spilloverScore,
      icuHeadroom,
      headroomScore,
      unspentCharges: unspent,
      chargeScore,
      cleanWeeks: this.cleanWeeks,
      cleanWeekScore: cleanScore,
      ecoBonus,
      ecoPenalty,
      mutatorMult: Number(mult.toFixed(3)),
      total: this.score,
    };
  },

  _fireGameOver(reason) {
    if (this.gameOverFired) return;
    this.gameOverFired = true;
    const detail = {
      mode: 'crisis_board',
      reason,
      result: this.result,
      week: this.week,
      score: this.score,
      seedStr: this.seedStr,
      doctrine: this.doctrine,
      scenario: this.scenario,
    };
    try {
      if (typeof window !== 'undefined') {
        if (typeof window.gameOver === 'function') { window.gameOver(reason, detail); return; }
        if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent('gameover', { detail }));
        }
        return;
      }
    } catch (err) { /* fall through to headless record */ }
    this._gameOverDetail = detail;
  },

  _nextEventSnapshot() {
    if (this.nextEvent && this.revealedThrough >= this.week + 1) {
      return { id: this.nextEvent.id, name: this.nextEvent.name, desc: this.nextEvent.desc, effect: this.nextEvent.effect, week: this.week + 1, revealed: true };
    }
    return { revealed: false, week: this.week + 1 };
  },
  /* ---------- flow / projection model ---------- */

  _flowsFor(loadMap, flowMult, cordons) {
    const flows = [];
    const cordonSet = new Set((cordons || []).map(c => c.edgeId));
    for (const e of this.edges) {
      const la = Number(loadMap[e.a]) || 0;
      const lb = Number(loadMap[e.b]) || 0;
      let fromId, mag;
      if (la >= lb) { fromId = e.a; mag = la - lb; } else { fromId = e.b; mag = lb - la; }
      const from = this.districtById[fromId];
      const mu = from && from.epi && Number.isFinite(from.epi.mu) ? from.epi.mu : 0;
      const amt = Math.round(clamp(mag * 0.055 * flowMult + mu * 0.02 * flowMult, 0, 26));
      if (amt <= 0) continue;
      const toId = fromId === e.a ? e.b : e.a;
      const cordoned = cordonSet.has(e.id);
      const blocked = cordoned ? Math.round(amt * CORDON_BLOCK) : 0;
      flows.push({ from: fromId, to: toId, amount: amt, blocked, applied: amt - blocked, edge: e.id });
    }
    return flows;
  },

  _districtFocus() {
    const hover = this.hoverDistrict ? this.districtById[this.hoverDistrict] : null;
    return hover || this.districtById[this.selectedDistrict] || this.districts[0] || null;
  },

  _planFromSelection() {
    if (this.phase !== 'allocate' || !this.selectedAction) return null;
    const a = this.selectedAction;
    const focus = this._districtFocus();
    if (a === 'cordon') return this.hoverBorder ? { actionId: 'cordon', edgeId: this.hoverBorder } : null;
    if (a === 'larvicide' || a === 'ovitrap_net' || a === 'deep_intel') {
      return focus ? { actionId: a, targetId: focus.id } : null;
    }
    if (a === 'ward_triage') return { actionId: 'ward_triage' };
    if (a === 'mass_fog') {
      if (this.pendingFogPrimary) {
        const primary = this.districtById[this.pendingFogPrimary];
        const hover = this.hoverDistrict ? this.districtById[this.hoverDistrict] : null;
        const nb = hover && primary && Array.isArray(primary.nb) && primary.nb.includes(hover.id) ? hover.id : null;
        return { actionId: 'mass_fog', targetId: this.pendingFogPrimary, neighborId: nb };
      }
      return focus ? { actionId: 'mass_fog', targetId: focus.id, neighborId: null } : null;
    }
    return null;
  },

  _hypCost(hyp) {
    const def = ACTION_MAP[hyp.actionId];
    return def ? def.apCost : 0;
  },

  _hypValid(hyp) {
    if (!hyp) return false;
    if (hyp.actionId === 'cordon') {
      const exists = this.cordons.some(c => c.edgeId === hyp.edgeId);
      if (exists) return true; // toggling off refunds the AP
      return this.ap >= 1 && this.cordons.length < this.cordonMax;
    }
    if (hyp.actionId === 'mass_fog') return this.ap >= 2 && this.week >= this.fogReadyWeek;
    if (hyp.actionId === 'deep_intel') return this.deepIntelCharges > 0;
    const def = ACTION_MAP[hyp.actionId];
    return def ? this.ap >= def.apCost : false;
  },

  _simulateWeek(hyp) {
    const week = this.week;
    const ev = this.currentEvent || {};
    const growth = (this.climate ? this.climate.mu : 1) * (ev.growthMult || 1);
    const flowMult = (this.climate ? this.climate.flow : 1) * (ev.flowMult || 1);

    // Instant effects (mass fog) reshape the load map used for spillover.
    const effLoad = {};
    const fogF = {};
    for (const d of this.districts) effLoad[d.id] = d.cases;
    if (hyp && hyp.actionId === 'mass_fog') {
      if (hyp.targetId && effLoad[hyp.targetId] !== undefined) {
        effLoad[hyp.targetId] *= (1 - MASS_FOG_PRIMARY);
        fogF[hyp.targetId] = 1 - MASS_FOG_PRIMARY;
      }
      if (hyp.neighborId && effLoad[hyp.neighborId] !== undefined) {
        effLoad[hyp.neighborId] *= (1 - MASS_FOG_NEIGHBOR);
        fogF[hyp.neighborId] = 1 - MASS_FOG_NEIGHBOR;
      }
    }

    // Cordons in force (active + hypothetical placement).
    const cordons = this.cordons.slice();
    if (hyp && hyp.actionId === 'cordon' && hyp.edgeId) {
      if (!cordons.some(c => c.edgeId === hyp.edgeId)) cordons.push({ edgeId: hyp.edgeId });
    }
    const flows = this._flowsFor(effLoad, flowMult, cordons);
    const inflow = {};
    for (const f of flows) inflow[f.to] = (inflow[f.to] || 0) + f.applied;
    if (ev.mildClusterCases) {
      const ranked = this.districts.slice().sort((a, b) => ((b.epi && b.epi.mu) || 0) - ((a.epi && a.epi.mu) || 0));
      for (const d of ranked.slice(0, 2)) inflow[d.id] = (inflow[d.id] || 0) + ev.mildClusterCases;
    }

    const proj = {};
    let totalProj = 0, collapseCount = 0;
    for (const d of this.districts) {
      const epi = d.epi || null;
      const mu0 = epi && Number.isFinite(epi.mu) ? epi.mu : d.cases;
      const mit = this._districtMitigation(d, week, hyp);
      const fogf = fogF[d.id] !== undefined ? fogF[d.id] : 1;
      const rMult = clamp(TRANSMISSION * growth * (1 - mit), 0.6, 1.6);
      const p = Math.max(0, Math.round(d.cases * fogf * rMult + (inflow[d.id] || 0) + mu0 * MU_SEED * (1 - mit)));
      proj[d.id] = p;
      totalProj += p;
      if (p >= 3 * d.endemicThreshold) collapseCount += 1;
    }
    const exceedRatio = this.districts.reduce((s, d) => s + clamp(proj[d.id] / (2 * d.endemicThreshold), 0, 2), 0) / this.districts.length;
    const admissions = Math.round(totalProj * ADMISSION_RATE * (1 + 0.35 * exceedRatio) * (ev.admissionsMult || 1)) + collapseCount * COLLAPSE_ADMISSIONS;
    const hypoTriageBeds = (hyp && hyp.actionId === 'ward_triage' && !(ev && ev.triageNullified))
      ? (this.doctrine === 'rapid_response_corps' ? 110 : 85) : 0;
    const surgeBeds = this._triageBeds(ev) + hypoTriageBeds;
    const discharges = BASE_DECAY + (surgeBeds > 0 ? TRIAGE_DISCHARGE_BOOST : 0) + (ev.dischargeDelta || 0);
    let loadAfter = this.hospitalLoad + admissions - discharges + (ev.loadDelta || 0);
    if (hyp && hyp.actionId === 'ward_triage') loadAfter -= (this.doctrine === 'rapid_response_corps' ? 30 : 24);
    const effCap = this.hospitalCap + surgeBeds;
    return {
      flows, proj,
      loadAfter: clamp(Math.round(loadAfter), 0, 9999),
      effCap, admissions, discharges, totalProj, collapseCount,
    };
  },

  _recomputePreview() {
    const hyp = this._planFromSelection();
    let sim = null, baseline = null;
    try { sim = this._simulateWeek(hyp); } catch (err) { sim = null; }
    try { baseline = this._simulateWeek(null); } catch (err) { baseline = sim; }
    if (!sim) return;
    this._arrows = sim.flows.map(f => ({ from: f.from, to: f.to, amount: f.amount, blocked: f.blocked, applied: f.applied, edge: f.edge }));
    const districtDeltas = {};
    for (const d of this.districts) {
      districtDeltas[d.id] = {
        before: Math.round(d.cases),
        after: sim.proj[d.id],
        delta: sim.proj[d.id] - Math.round(d.cases),
        baseline: baseline ? baseline.proj[d.id] : sim.proj[d.id],
      };
    }
    const blockedDelta = sim.flows.reduce((s, f) => s + f.blocked, 0);
    let note = 'BASELINE PROJECTION - NO ACTION QUEUED';
    if (hyp) {
      const def = ACTION_MAP[hyp.actionId];
      note = def ? def.fullName.toUpperCase() : String(hyp.actionId).toUpperCase();
      if (hyp.actionId === 'mass_fog' && !hyp.neighborId && this.pendingFogPrimary) note = 'CHOOSE ADJACENT NEIGHBOR FOR -25% FOG';
      if (!this._hypValid(hyp)) note += ' - UNAVAILABLE';
    }
    this.preview = {
      action: hyp ? hyp.actionId : null,
      valid: hyp ? this._hypValid(hyp) : true,
      label: note,
      districtDeltas,
      spillover: sim.flows.map(f => ({ from: f.from, to: f.to, amount: f.amount, blocked: f.blocked, applied: f.applied })),
      hospital: {
        loadBefore: Math.round(this.hospitalLoad),
        loadAfter: sim.loadAfter,
        capBefore: this.hospitalCap,
        capAfter: sim.effCap,
      },
      baselineLoadAfter: baseline ? baseline.loadAfter : sim.loadAfter,
      spilloverBlockedDelta: blockedDelta,
      apAfter: hyp ? Math.max(0, this.ap - this._hypCost(hyp)) : this.ap,
    };
  },

  /* ---------- action casting ---------- */

  _selectAction(id) {
    if (!ACTION_MAP[id]) return;
    if (this.phase === 'intel') this.phase = 'allocate';
    this.selectedAction = this.selectedAction === id ? null : id;
    if (this.selectedAction !== 'mass_fog') this.pendingFogPrimary = null;
    this._setMessage(this.selectedAction ? ACTION_MAP[id].fullName.toUpperCase() + ' SELECTED' : 'ACTION DESELECTED', 2);
    this._sfx('tap');
    this._recomputePreview();
  },

  _spendAp(n) {
    this.ap = Math.max(0, this.ap - n);
  },

  _toggleCordon(edge) {
    if (this.phase !== 'allocate') { this._setMessage('ENTER COMMAND ALLOCATION TO PLACE CORDONS', 2.5); return; }
    const existing = this.cordons.find(c => c.edgeId === edge.id);
    if (existing) {
      this.cordons = this.cordons.filter(c => c !== existing);
      this.ap = Math.min(this.maxAp, this.ap + 1);
      this._setMessage('CORDON REMOVED - AP REFUNDED', 2.5);
      this._sfx('undeploy');
      this._recomputePreview();
      return;
    }
    if (this.cordons.length >= this.cordonMax) { this._setMessage('CORDON LIMIT REACHED (' + this.cordonMax + ')', 2.5); this._sfx('deny'); return; }
    if (this.ap < 1) { this._setMessage('INSUFFICIENT AP', 2.5); this._sfx('deny'); return; }
    this.cordons.push({ id: 'cordon-' + this.week + '-' + edge.id, edgeId: edge.id, a: edge.a, b: edge.b, weeksLeft: CORDON_WEEKS });
    this._spendAp(1);
    this._setMessage('CORDON SET: ' + edge.a.toUpperCase() + ' <-> ' + edge.b.toUpperCase() + ' (2 WEEKS)', 3);
    this._sfx('deploy');
    this._recomputePreview();
  },

  _onDistrictClick(d) {
    this.selectedDistrict = d.id;
    const action = this.phase === 'allocate' ? this.selectedAction : null;
    if (!action) { this._recomputePreview(); return; }
    if (action === 'larvicide') return this._castLarvicide(d);
    if (action === 'ovitrap_net') return this._castOvitrap(d);
    if (action === 'deep_intel') return this._castDeepIntel(d);
    if (action === 'ward_triage') return this._castWardTriage();
    if (action === 'mass_fog') return this._castMassFogStep(d);
    if (action === 'cordon') this._setMessage('CORDON TARGETS BORDER LOCK NODES', 2.5);
    this._recomputePreview();
  },

  _castLarvicide(d) {
    if (this.ap < 1) { this._setMessage('INSUFFICIENT AP', 2.5); this._sfx('deny'); return; }
    const weeks = this.doctrine === 'biocontrol_taskforce' ? 3 : 2;
    d.larvicideUntil = Math.max(d.larvicideUntil || 0, this.week + weeks - 1);
    this._spendAp(1);
    this._setMessage('LARVICIDE BLITZ: ' + d.name + ' -35% GROWTH, ' + weeks + ' WEEKS', 3);
    this._sfx('deploy');
    this._recomputePreview();
  },

  _castOvitrap(d) {
    if (this.ap < 1) { this._setMessage('INSUFFICIENT AP', 2.5); this._sfx('deny'); return; }
    d.ovitrapUntil = Math.max(d.ovitrapUntil || 0, this.week + 2); // 3 weeks incl. current
    this._spendAp(1);
    this._setMessage('OVITRAP GRID: ' + d.name + ' -22% CASES/WK, 3 WEEKS', 3);
    this._sfx('trap');
    this._recomputePreview();
  },

  _castWardTriage() {
    if (this.ap < 1) { this._setMessage('INSUFFICIENT AP', 2.5); this._sfx('deny'); return; }
    const rapid = this.doctrine === 'rapid_response_corps';
    const beds = rapid ? 110 : 85;
    const cut = rapid ? 30 : 24;
    this.triageSurges.push({ untilWeek: this.week + 1, amount: beds });
    this.hospitalLoad = Math.max(0, this.hospitalLoad - cut);
    this._spendAp(1);
    this._setMessage('WARD SURGE: +' + beds + ' BEDS / 2 WEEKS, LOAD -' + cut, 3);
    this._sfx('heal');
    this._recomputePreview();
  },

  _castDeepIntel(d) {
    if (this.deepIntelCharges <= 0) { this._setMessage('NO DEEP SURVEILLANCE CHARGES LEFT', 2.5); this._sfx('deny'); return; }
    this.deepIntelCharges -= 1;
    d.deepIntelUntil = Math.max(d.deepIntelUntil || 0, this.week + 1);
    this.revealedThrough = Math.max(this.revealedThrough, this.week + 1);
    this._setMessage('DEEP SURVEILLANCE: NEXT 2 WEEKS REVEALED; ' + d.name + ' +15% MITIGATION', 4);
    this._sfx('lit');
    this._recomputePreview();
  },

  _castMassFogStep(d) {
    if (this.ap < 2) { this._setMessage('INSUFFICIENT AP (MASS FOG COSTS 2)', 2.5); this._sfx('deny'); return; }
    if (this.week < this.fogReadyWeek) { this._setMessage('MASS FOG ON COOLDOWN UNTIL WEEK ' + this.fogReadyWeek, 2.5); this._sfx('deny'); return; }
    if (!this.pendingFogPrimary) {
      this.pendingFogPrimary = d.id;
      this._setMessage('FOG TARGET SET: ' + d.name + ' - CHOOSE ADJACENT NEIGHBOR FOR -25%', 3.5);
      this._sfx('tap');
      this._recomputePreview();
      return;
    }
    if (this.pendingFogPrimary === d.id) {
      this.pendingFogPrimary = null;
      this._setMessage('FOG TARGET CANCELLED', 2);
      this._recomputePreview();
      return;
    }
    const primary = this.districtById[this.pendingFogPrimary];
    if (primary && Array.isArray(primary.nb) && primary.nb.includes(d.id)) {
      primary.cases = Math.max(0, Math.round(primary.cases * (1 - MASS_FOG_PRIMARY)));
      d.cases = Math.max(0, Math.round(d.cases * (1 - MASS_FOG_NEIGHBOR)));
      primary.fogFlash = 1;
      d.fogFlash = 1;
      this.massFogUses += 1;
      this.fogReadyWeek = this.week + MASS_FOG_COOLDOWN;
      this._spendAp(2);
      this.pendingFogPrimary = null;
      this.selectedAction = null;
      this._setMessage('SECTOR FOGGING: ' + primary.name + ' -55%, ' + d.name + ' -25% (-150 ECO)', 4);
      this._sfx('spray');
      this._recomputePreview();
      return;
    }
    this._setMessage('NEIGHBOR MUST SHARE A BORDER WITH ' + (primary ? primary.name : 'TARGET'), 3);
    this._sfx('deny');
  },
  _actionState(a) {
    const state = { cooldownReady: true, disabledReason: null };
    if (a.id === 'mass_fog') {
      if (this.week < this.fogReadyWeek) { state.cooldownReady = false; state.disabledReason = 'COOLDOWN UNTIL WK ' + this.fogReadyWeek; }
      else if (this.ap < a.apCost) state.disabledReason = 'INSUFFICIENT AP';
    } else if (a.id === 'deep_intel') {
      if (this.deepIntelCharges <= 0) { state.cooldownReady = false; state.disabledReason = 'NO CHARGES LEFT'; }
    } else if (a.id === 'cordon') {
      if (this.cordons.length >= this.cordonMax) state.disabledReason = 'MAX ACTIVE (' + this.cordonMax + ')';
      else if (this.ap < a.apCost) state.disabledReason = 'INSUFFICIENT AP';
    } else if (this.ap < a.apCost) {
      state.disabledReason = 'INSUFFICIENT AP';
    }
    return state;
  },

  /* ---------- shared draw utilities ---------- */

  _rr(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.arcTo(x + w, y, x + w, y + rad, rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
    ctx.lineTo(x + rad, y + h);
    ctx.arcTo(x, y + h, x, y + h - rad, rad);
    ctx.lineTo(x, y + rad);
    ctx.arcTo(x, y, x + rad, y, rad);
    ctx.closePath();
  },

  _text(ctx, txt, x, y, opts) {
    const o = opts || {};
    const size = o.size || 11;
    const color = o.color || '#E6F0F2';
    const align = o.align || 'left';
    const mono = o.font === 'mono';
    ctx.save();
    ctx.font = (o.weight === 400 ? '400 ' : '700 ') + size + 'px ' + (mono ? '"JetBrains Mono", "Cascadia Mono", Consolas, monospace' : '"Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif');
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(String(txt), x, y);
    ctx.restore();
  },

  _wrap(ctx, text, x, y, maxWidth, lineHeight, opts) {
    const o = opts || {};
    const size = o.size || 8.5;
    const color = o.color || '#C4D4D9';
    const maxLines = o.maxLines || 4;
    ctx.save();
    ctx.font = '400 ' + size + 'px "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const words = String(text || '').split(/\s+/).filter(Boolean);
    let line = '', lines = 0;
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y + lines * lineHeight);
        lines += 1; line = word;
        if (lines >= maxLines) break;
      } else line = test;
    }
    if (line && lines < maxLines) { ctx.fillText(line, x, y + lines * lineHeight); lines += 1; }
    ctx.restore();
    return lines;
  },

  _panel(ctx, x, y, w, h) {
    ctx.save();
    this._rr(ctx, x, y, w, h, 8);
    ctx.fillStyle = 'rgba(19, 34, 41, 0.92)';
    ctx.fill();
    ctx.strokeStyle = '#2E4D5B';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  },

  _button(ctx, id, x, y, w, h, label, opts) {
    const o = opts || {};
    ctx.save();
    this._rr(ctx, x, y, w, h, 8);
    ctx.fillStyle = o.bg || '#F59E0B';
    ctx.fill();
    if (o.stroke) { ctx.strokeStyle = o.stroke; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.restore();
    this._text(ctx, label, x + w / 2, y + h / 2 - (o.sub ? 6 : 0), { size: o.size || 12, color: o.fg || '#0A1317', align: 'center' });
    if (o.sub) this._text(ctx, o.sub, x + w / 2, y + h / 2 + 9, { size: 6.5, color: o.fg || '#0A1317', align: 'center', weight: 400 });
    this._buttons.push({ id, x, y, w, h });
  },

  _hitButton(sx, sy) {
    for (const b of this._buttons) {
      if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) return b;
    }
    return null;
  },

  _onButton(id) {
    if (id === 'begin') return this._beginAllocation();
    if (id === 'endweek') return this._resolveWeek();
    if (id && id.indexOf('action:') === 0) return this._selectAction(id.slice(7));
    return null;
  },

  _nearestBorder(mx, my, radius) {
    let best = null, bestDist = radius;
    for (const e of this.edges) {
      const dx = mx - e.mid[0], dy = my - e.mid[1];
      const dist = Math.hypot(dx, dy);
      if (dist <= bestDist) { bestDist = dist; best = e; }
    }
    return best;
  },

  /* ---------- map-space overlays ---------- */

  _drawScanSweep(ctx, time) {
    const span = 240;
    const cycle = CORRIDOR.MW + span * 2;
    const x = CORRIDOR.MX0 - span + ((time * 55) % cycle);
    try {
      const grad = ctx.createLinearGradient(x, 0, x + span, 0);
      grad.addColorStop(0, 'rgba(56, 189, 248, 0)');
      grad.addColorStop(0.5, 'rgba(56, 189, 248, 0.055)');
      grad.addColorStop(1, 'rgba(56, 189, 248, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, 0, span, CORRIDOR.HEIGHT);
    } catch (err) { /* gradient unsupported headless */ }
  },

  _drawFlows(ctx, time) {
    const flows = this._arrows || [];
    for (const f of flows) {
      if (!f || f.amount <= 0) continue;
      const A = this.districtById[f.from], B = this.districtById[f.to];
      if (!A || !B) continue;
      const ax = A.c[0], ay = A.c[1], bx = B.c[0], by = B.c[1];
      const sx = lerp(ax, bx, 0.22), sy = lerp(ay, by, 0.22);
      const ex = lerp(ax, bx, 0.78), ey = lerp(ay, by, 0.78);
      const blocked = f.blocked > 0;
      ctx.save();
      ctx.strokeStyle = blocked ? 'rgba(148, 163, 184, 0.62)' : '#EF4444';
      ctx.lineWidth = blocked ? 2 : 3;
      ctx.setLineDash([10, 7]);
      ctx.lineDashOffset = -time * 46;
      if (!blocked) { ctx.shadowColor = '#EF4444'; ctx.shadowBlur = 9; }
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      // Chevron arrowhead at the downstream end.
      const ang = Math.atan2(ey - sy, ex - sx);
      ctx.setLineDash([]);
      ctx.lineWidth = blocked ? 2 : 2.6;
      for (const off of [2.55, -2.55]) {
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(ang + off) * 11, ey - Math.sin(ang + off) * 11);
        ctx.stroke();
      }
      ctx.restore();
      // Flow magnitude label chip at the midpoint.
      const mx = (sx + ex) / 2, my = (sy + ey) / 2;
      const label = blocked && f.applied <= 0 ? 'HELD' : '+' + f.applied;
      ctx.save();
      ctx.font = '700 9px "JetBrains Mono", "Cascadia Mono", Consolas, monospace';
      const wText = Math.max(18, ctx.measureText(label).width + 10);
      this._rr(ctx, mx - wText / 2, my - 7, wText, 14, 7);
      ctx.fillStyle = 'rgba(6, 12, 15, 0.82)';
      ctx.fill();
      ctx.fillStyle = blocked ? '#94A3B8' : '#FCA5A5';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, my + 0.5);
      if (blocked) {
        ctx.font = '700 6.5px "JetBrains Mono", "Cascadia Mono", Consolas, monospace';
        ctx.fillStyle = '#F59E0B';
        ctx.fillText('HELD ' + f.blocked, mx, my + 13);
      }
      ctx.restore();
    }
  },

  _drawBorderNodes(ctx, time) {
    const cordonByEdge = new Map(this.cordons.map(c => [c.edgeId, c]));
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const cordon = cordonByEdge.get(e.id) || null;
      if (cordon) {
        try {
          drawQuarantineEdge(ctx, { a: e.seg[0], b: e.seg[1] }, { time, color: '#F59E0B', width: 4 });
        } catch (err) {
          ctx.save();
          ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 4;
          ctx.setLineDash([9, 7]); ctx.lineDashOffset = -time * 36;
          ctx.beginPath(); ctx.moveTo(e.seg[0][0], e.seg[0][1]); ctx.lineTo(e.seg[1][0], e.seg[1][1]); ctx.stroke();
          ctx.restore();
          ctx.setLineDash([]);
        }
      }
      const hovered = this.hoverBorder === e.id;
      const pulse = (Math.sin(time * 3 + i * 1.7) + 1) / 2;
      ctx.save();
      if (cordon) {
        ctx.fillStyle = '#F59E0B';
        ctx.strokeStyle = 'rgba(6, 12, 15, 0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(e.mid[0], e.mid[1], 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        // Lock glyph.
        ctx.strokeStyle = '#0A1317'; ctx.lineWidth = 1.6;
        ctx.strokeRect(e.mid[0] - 3, e.mid[1] - 1, 6, 5);
        ctx.beginPath(); ctx.arc(e.mid[0], e.mid[1] - 1.5, 2.4, Math.PI, 0); ctx.stroke();
      } else {
        const r = 5.5 + pulse * 1.6;
        ctx.globalAlpha = hovered ? 1 : 0.55 + pulse * 0.25;
        ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
        ctx.strokeStyle = hovered ? '#7DD3FC' : '#38BDF8';
        ctx.lineWidth = hovered ? 2.2 : 1.5;
        ctx.beginPath(); ctx.arc(e.mid[0], e.mid[1], r + (hovered ? 3 : 0), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = hovered ? '#BAE6FD' : '#38BDF8';
        ctx.beginPath(); ctx.arc(e.mid[0], e.mid[1], 2.2, 0, Math.PI * 2); ctx.fill();
        if (hovered) {
          ctx.globalAlpha = 0.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.arc(e.mid[0], e.mid[1], 22, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      ctx.restore();
    }
  },

  _drawDistrictMicro(ctx, time) {
    for (const d of this.districts) {
      const x = d.c[0], y = d.c[1];
      this._text(ctx, d.name || String(d.id).toUpperCase(), x, y - 16, { size: 6.5, color: 'rgba(230, 240, 242, 0.70)', align: 'center', weight: 400 });
      this._text(ctx, String(Math.round(d.cases)), x, y + 3, { size: 9, color: '#E6F0F2', align: 'center', font: 'mono' });
      // Threat meter bar.
      const bw = 46, bh = 4, bx = x - bw / 2, by = y + 12;
      ctx.save();
      ctx.fillStyle = 'rgba(6, 12, 15, 0.78)';
      ctx.fillRect(bx, by, bw, bh);
      const t = clamp01((d.threat || 0) / 100);
      ctx.fillStyle = t < 0.35 ? '#10B981' : t < 0.65 ? '#F59E0B' : '#EF4444';
      ctx.fillRect(bx, by, bw * t, bh);
      ctx.restore();
      const thr = Number.isFinite(d.endemicThreshold) ? d.endemicThreshold : 100;
      if (d.cases >= 3 * thr) {
        const pulse = (Math.sin(time * 5) + 1) / 2;
        ctx.save();
        ctx.strokeStyle = 'rgba(239, 68, 68, ' + (0.55 + pulse * 0.45) + ')';
        ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.arc(x, y, 17 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        this._text(ctx, 'UNCONTAINED', x, y + 25, { size: 6.5, color: '#F87171', align: 'center' });
      }
    }
  },

  _drawResolutionCues(ctx, time) {
    const outcome = this._resOutcome;
    if (!outcome) return;
    const t = this._resT || 0;
    // Floating net-delta numbers per district (staggered reveal).
    for (const cue of outcome.cues || []) {
      if (t < cue.at) continue;
      const p = clamp01((t - cue.at) / 0.8);
      ctx.save();
      ctx.globalAlpha = 1 - p;
      this._text(ctx, cue.text, cue.x, cue.y - 32 * easeOut(p), { size: 12, color: cue.color, align: 'center', font: 'mono' });
      ctx.restore();
    }
    // Border lock flashes where cordons held the line.
    for (const f of outcome.flows || []) {
      if (!f || f.blocked <= 0) continue;
      const e = this.edgeById[f.edge];
      if (!e) continue;
      const p = clamp01(t / 0.9);
      ctx.save();
      ctx.strokeStyle = 'rgba(245, 158, 11, ' + (1 - p).toFixed(3) + ')';
      ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.arc(e.mid[0], e.mid[1], 6 + easeOut(p) * 26, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    // Containment pulses on treated or spillover-fed districts.
    for (const d of this.districts) {
      const treated = (this.week <= d.larvicideUntil) || (this.week <= d.ovitrapUntil) || ((d.inflow || 0) > 0);
      if (!treated) continue;
      const p = clamp01((t - 0.15) / 1.1);
      if (p <= 0) continue;
      ctx.save();
      ctx.strokeStyle = 'rgba(45, 212, 191, ' + (0.75 * (1 - p)).toFixed(3) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(d.c[0], d.c[1], 8 + easeOut(p) * 34, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  },
  /* ---------- screen-space UI chrome ---------- */

  _drawTopStrip(ctx, v, time) {
    const w = v.w;
    ctx.save();
    const g = ctx.createLinearGradient(0, 0, 0, 56);
    g.addColorStop(0, 'rgba(6, 12, 15, 0.88)');
    g.addColorStop(1, 'rgba(6, 12, 15, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, 56);
    ctx.restore();
    this._text(ctx, 'CRISIS BOARD // WEEK ' + this.week + '/' + TOTAL_WEEKS, 14, 15, { size: 13, color: '#F59E0B', font: 'mono' });
    this._text(ctx, 'SATGAS DBD - SOLO-YOGYA CORRIDOR', 14, 31, { size: 7, color: '#8FA8B2', weight: 400 });
    const phaseLabel = {
      intel: 'PHASE 1/3 - INTEL BRIEFING',
      allocate: 'PHASE 2/3 - COMMAND ALLOCATION',
      resolution: 'PHASE 3/3 - WEEKLY RESOLUTION',
      over: 'AFTER ACTION REVIEW',
    }[this.phase] || this.phase;
    this._text(ctx, phaseLabel, w / 2, 14, { size: 11, color: '#38BDF8', align: 'center', font: 'mono' });
    const effCap = this._effectiveCap();
    const load = this._displayedLoad();
    this._text(ctx, 'HOSPITAL ' + load + '/' + effCap, w / 2, 31, { size: 9, color: load > 0.85 * effCap ? '#EF4444' : '#E6F0F2', align: 'center', font: 'mono' });
    const rx = w - 14;
    this._text(ctx, 'AP ' + this.ap + '/' + this.maxAp, rx, 12, { size: 11, color: '#E6F0F2', align: 'right', font: 'mono' });
    this._text(ctx, 'CORDONS ' + this.cordons.length + '/' + this.cordonMax, rx, 26, { size: 8, color: '#F59E0B', align: 'right', font: 'mono', weight: 400 });
    this._text(ctx, 'INTEL ' + this.deepIntelCharges, rx, 39, { size: 8, color: '#38BDF8', align: 'right', font: 'mono', weight: 400 });
  },

  _drawEventCard(ctx, v, time) {
    const x = 12, y = 42, w = 252, h = 148;
    this._panel(ctx, x, y, w, h);
    this._text(ctx, 'WEEKLY EVENT - WEEK ' + this.week, x + 12, y + 14, { size: 7.5, color: '#38BDF8', weight: 400 });
    const name = this.currentEvent ? this.currentEvent.name.toUpperCase() : 'NO SIGNAL';
    this._text(ctx, name, x + 12, y + 30, { size: 11.5, color: '#F59E0B' });
    this._wrap(ctx, this.currentEvent ? this.currentEvent.desc : 'Awaiting surveillance synthesis.', x + 12, y + 46, w - 24, 11, { size: 8, color: '#C4D4D9', maxLines: 3 });
    this._wrap(ctx, this.currentEvent ? this.currentEvent.effect : '', x + 12, y + 92, w - 24, 11, { size: 7.5, color: '#2DD4BF', maxLines: 2 });
    if (this.revealedThrough >= this.week + 1 && this.nextEvent) {
      this._panel(ctx, x, y + h + 6, w, 30);
      this._text(ctx, 'NEXT WEEK: ' + this.nextEvent.name.toUpperCase(), x + 12, y + h + 16, { size: 8, color: '#7DD3FC' });
      this._text(ctx, 'PRE-REVEALED BY SURVEILLANCE', x + 12, y + h + 26, { size: 6, color: '#5B737E', weight: 400 });
    } else if (this.nextEvent) {
      this._text(ctx, 'NEXT WEEK: SIGNAL ENCRYPTED', x + 2, y + h + 12, { size: 7, color: '#5B737E', weight: 400 });
    }
  },

  _drawPreviewPanel(ctx, v, time) {
    const pw = 252, ph = 146;
    const x = 12, y = v.h - 66 - 10 - ph;
    this._panel(ctx, x, y, pw, ph);
    this._text(ctx, 'DRY-RUN PREVIEW', x + 12, y + 12, { size: 8, color: '#38BDF8' });
    this._text(ctx, 'BEFORE RESOLVE', x + pw - 12, y + 12, { size: 6.5, color: '#5B737E', align: 'right', weight: 400 });
    const p = this.preview;
    if (!p) { this._text(ctx, 'NO PROJECTION AVAILABLE', x + 12, y + 32, { size: 8, color: '#8FA8B2' }); return; }
    const labelColor = p.valid ? '#F59E0B' : '#EF4444';
    this._text(ctx, p.label, x + 12, y + 27, { size: 8, color: labelColor, weight: 400 });
    const entries = Object.entries(p.districtDeltas || {})
      .map(([id, row]) => ({ id, ...row }))
      .filter(row => row.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 5);
    let ry = y + 43;
    if (!entries.length) {
      this._text(ctx, 'CASELOAD STABLE IN ALL DISTRICTS', x + 12, ry, { size: 8, color: '#8FA8B2', weight: 400 });
      ry += 14;
    } else {
      for (const row of entries) {
        const nm = String(row.id).toUpperCase().slice(0, 11).padEnd(11, ' ');
        const deltaTxt = (row.delta >= 0 ? ' +' : ' ') + row.delta;
        this._text(ctx, nm, x + 12, ry, { size: 7.5, color: '#8FA8B2', font: 'mono', weight: 400 });
        this._text(ctx, String(row.before) + '>' + String(row.after), x + 96, ry, { size: 7.5, color: '#E6F0F2', font: 'mono', weight: 400 });
        this._text(ctx, deltaTxt, x + pw - 12, ry, { size: 7.5, color: row.delta > 0 ? '#F87171' : '#34D399', align: 'right', font: 'mono' });
        ry += 13;
      }
    }
    const hs = p.hospital || {};
    const capAfter = hs.capAfter != null ? hs.capAfter : this.hospitalCap;
    const over = (hs.loadAfter || 0) > capAfter;
    this._text(ctx, 'HOSPITAL ' + (hs.loadBefore != null ? hs.loadBefore : '-') + ' > ' + (hs.loadAfter != null ? hs.loadAfter : '-') + ' / CAP ' + capAfter, x + 12, y + ph - 28, { size: 8, color: over ? '#EF4444' : '#E6F0F2', font: 'mono' });
    if (p.spilloverBlockedDelta > 0) {
      this._text(ctx, 'CORDONS HOLD ' + p.spilloverBlockedDelta + ' PROJECTED CASES', x + 12, y + ph - 14, { size: 7, color: '#F59E0B', weight: 400 });
    } else {
      this._text(ctx, 'AP AFTER RESOLUTION: ' + (p.apAfter != null ? p.apAfter : this.ap), x + 12, y + ph - 14, { size: 7, color: '#5B737E', weight: 400 });
    }
  },

  _drawActionBar(ctx, v, time) {
    const chipW = 106, chipH = 56, gap = 8;
    const total = ACTION_DEFS.length * chipW + (ACTION_DEFS.length - 1) * gap;
    const x0 = (v.w - total) / 2, y = v.h - 64;
    // Contextual hint line above the chips.
    let hint = '';
    if (this.phase === 'allocate' && this.selectedAction) {
      if (this.selectedAction === 'cordon') hint = 'CLICK A BORDER LOCK NODE (22px) TO PLACE OR REMOVE A CORDON';
      else if (this.selectedAction === 'ward_triage') hint = 'SURGE IS REGIONAL - CLICK ANY DISTRICT TO DEPLOY';
      else if (this.selectedAction === 'mass_fog') hint = this.pendingFogPrimary ? 'CHOOSE AN ADJACENT NEIGHBOR FOR THE -25% FOG' : 'CLICK A DISTRICT FOR THE -55% FOG';
      else hint = 'CLICK A DISTRICT TO APPLY';
    } else if (this.phase === 'intel') hint = 'REVIEW THE BRIEFING, THEN BEGIN ALLOCATION';
    if (hint) this._text(ctx, hint, v.w / 2, y - 9, { size: 7.5, color: '#8FA8B2', align: 'center', weight: 400 });

    for (let i = 0; i < ACTION_DEFS.length; i++) {
      const a = ACTION_DEFS[i];
      const x = x0 + i * (chipW + gap);
      const selected = this.selectedAction === a.id;
      const state = this._actionState(a);
      const disabled = !!state.disabledReason || state.cooldownReady === false;
      ctx.save();
      ctx.globalAlpha = disabled ? 0.55 : 1;
      this._rr(ctx, x, y, chipW, chipH, 7);
      ctx.fillStyle = selected ? 'rgba(245, 158, 11, 0.20)' : 'rgba(19, 34, 41, 0.94)';
      ctx.fill();
      ctx.strokeStyle = selected ? '#F59E0B' : '#2E4D5B';
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = disabled ? 0.6 : 1;
      this._text(ctx, a.key, x + 6, y + 9, { size: 8, color: '#38BDF8', font: 'mono' });
      this._text(ctx, a.apCost + ' AP', x + chipW - 6, y + 9, { size: 8, color: a.apCost === 0 ? '#2DD4BF' : '#F59E0B', align: 'right', font: 'mono' });
      this._text(ctx, a.name, x + chipW / 2, y + 22, { size: 10, color: '#E6F0F2', align: 'center' });
      let sub = '';
      if (a.id === 'cordon') sub = 'ACTIVE ' + this.cordons.length + '/' + this.cordonMax;
      else if (a.id === 'deep_intel') sub = 'CHARGES ' + this.deepIntelCharges;
      else if (a.id === 'mass_fog') sub = this.week < this.fogReadyWeek ? 'CD WK ' + this.fogReadyWeek : '-55/-25 READY';
      else if (a.id === 'ward_triage') sub = '+' + (this.doctrine === 'rapid_response_corps' ? 110 : 85) + ' BEDS';
      else if (a.id === 'larvicide') sub = this.doctrine === 'biocontrol_taskforce' ? '3-WEEK EFFECT' : '2-WEEK EFFECT';
      else if (a.id === 'ovitrap_net') sub = '-22% / 3 WEEKS';
      this._text(ctx, sub, x + chipW / 2, y + 37, { size: 6.5, color: '#8FA8B2', align: 'center', weight: 400 });
      if (state.disabledReason && a.id !== 'cordon') {
        this._text(ctx, state.disabledReason, x + chipW / 2, y + 49, { size: 6, color: '#EF4444', align: 'center', weight: 400 });
      } else {
        this._text(ctx, selected ? 'SELECTED' : a.target.replace(/_/g, ' ').toUpperCase(), x + chipW / 2, y + 49, { size: 6, color: selected ? '#FBBF24' : '#5B737E', align: 'center', weight: 400 });
      }
      ctx.restore();
      this._buttons.push({ id: 'action:' + a.id, x, y, w: chipW, h: chipH });
    }
  },

  _drawPhaseControl(ctx, v, time) {
    const bw = 208, bh = 42;
    const x = v.w - bw - 12, y = v.h - 64 - 10 - bh;
    if (this.phase === 'intel') {
      this._button(ctx, 'begin', x, y, bw, bh, 'BEGIN ALLOCATION', { bg: '#F59E0B', fg: '#0A1317', size: 12, sub: 'ENTER' });
    } else if (this.phase === 'allocate') {
      this._button(ctx, 'endweek', x, y, bw, bh, 'END WEEK / RESOLVE', { bg: '#F59E0B', fg: '#0A1317', size: 12, sub: 'ENTER - COMMIT ORDERS' });
    } else if (this.phase === 'resolution') {
      const frac = clamp01((this._resT || 0) / 1.5);
      ctx.save();
      this._rr(ctx, x, y, bw, bh, 8);
      ctx.fillStyle = 'rgba(19, 34, 41, 0.94)';
      ctx.fill();
      ctx.strokeStyle = '#2E4D5B'; ctx.lineWidth = 1; ctx.stroke();
      this._rr(ctx, x + 6, y + bh - 14, (bw - 12) * frac, 6, 3);
      ctx.fillStyle = '#38BDF8';
      ctx.fill();
      ctx.restore();
      this._text(ctx, 'RESOLVING WEEK ' + this.week + '...', x + bw / 2, y + 14, { size: 10, color: '#7DD3FC', align: 'center', font: 'mono' });
    }
  },

  _drawMessage(ctx, v, time) {
    if (!this.message || this.messageUntil <= 0) return;
    const text = String(this.message);
    ctx.save();
    ctx.font = '700 9px "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif';
    const wText = Math.min(620, ctx.measureText(text).width + 28);
    ctx.restore();
    const x = (v.w - wText) / 2, y = v.h - 78;
    ctx.save();
    this._rr(ctx, x, y - 10, wText, 20, 10);
    ctx.fillStyle = 'rgba(6, 12, 15, 0.85)';
    ctx.fill();
    ctx.restore();
    this._text(ctx, text, v.w / 2, y + 0.5, { size: 9, color: '#E6F0F2', align: 'center', weight: 400 });
  },

  _drawCenterTag(ctx, v, text) {
    const w = 320, h = 34;
    const x = (v.w - w) / 2, y = v.h / 2 - h / 2;
    ctx.save();
    this._rr(ctx, x, y, w, h, 8);
    ctx.fillStyle = 'rgba(6, 12, 15, 0.82)';
    ctx.fill();
    ctx.strokeStyle = '#2E4D5B';
    ctx.stroke();
    ctx.restore();
    this._text(ctx, text, v.w / 2, y + h / 2, { size: 10, color: '#E6F0F2', align: 'center', font: 'mono' });
  },

  _drawOverOverlay(ctx, v, time) {
    const w = v.w, h = v.h;
    ctx.save();
    ctx.fillStyle = 'rgba(6, 12, 15, 0.74)';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    const pw = 520, ph = 292;
    const x = (w - pw) / 2, y = (h - ph) / 2;
    const win = this.result === 'win';
    const accent = win ? '#F59E0B' : '#EF4444';
    ctx.save();
    this._rr(ctx, x, y, pw, ph, 12);
    ctx.fillStyle = 'rgba(19, 34, 41, 0.97)';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    this._text(ctx, win ? 'CORRIDOR HELD' : 'REGION OVERWHELMED', w / 2, y + 30, { size: 21, color: accent, align: 'center' });
    const sub = win ? 'WEEK 8/8 COMPLETE - LOAD WITHIN CAPACITY'
      : (this.lossReason === 'collapse' ? 'UNCONTAINED DISTRICT COLLAPSE AT WEEK ' + this.week
        : 'HOSPITAL SYSTEM OVERLOAD AT WEEK ' + this.week);
    this._text(ctx, sub, w / 2, y + 52, { size: 8.5, color: '#8FA8B2', align: 'center', weight: 400 });
    this._text(ctx, 'FINAL SCORE', w / 2, y + 74, { size: 8, color: '#5B737E', align: 'center', weight: 400 });
    this._text(ctx, String(Math.round(this.score || 0)), w / 2, y + 100, { size: 32, color: '#E6F0F2', align: 'center', font: 'mono' });
    const sp = this.scoreParts;
    if (sp) {
      const col1 = x + 34, col2 = x + pw / 2 + 12;
      const line = (cx, cy, label, value) => {
        this._text(ctx, label, cx, cy, { size: 7.5, color: '#8FA8B2', weight: 400 });
        this._text(ctx, value, cx + 188, cy, { size: 7.5, color: '#E6F0F2', align: 'right', font: 'mono', weight: 400 });
      };
      line(col1, y + 136, 'SPILLOVER BLOCKED x' + sp.spilloverBlocked, '+' + sp.spilloverScore);
      line(col1, y + 152, 'ICU HEADROOM ' + sp.icuHeadroom, '+' + sp.headroomScore);
      line(col1, y + 168, 'UNSPENT CHARGES ' + sp.unspentCharges, '+' + sp.chargeScore);
      line(col1, y + 184, 'CLEAN WEEKS ' + sp.cleanWeeks, '+' + sp.cleanWeekScore);
      line(col2, y + 136, 'ECO BONUS' + (sp.ecoBonus ? '' : ' (FORFEIT)'), '+' + sp.ecoBonus);
      line(col2, y + 152, 'FOG PENALTY ' + this.massFogUses + ' USE(S)', '-' + sp.ecoPenalty);
      line(col2, y + 168, 'MUTATOR MULTIPLIER', 'x' + sp.mutatorMult);
    }
    this._text(ctx, 'AWAITING COMMAND HUB DEBRIEF', w / 2, y + ph - 16, { size: 7.5, color: '#5B737E', align: 'center', weight: 400 });
  },
});
