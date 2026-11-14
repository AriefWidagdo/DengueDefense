/* ============================================================================
   Dengue Defense — Field Edition :: Mode 3 — Outbreak Blitz (Continuous 2:30)
   Emergency Interception Hotline: zero planning menus, zero pause-modals,
   continuous real-time arcade survival across the Solo–Yogya corridor.

   Implements the Mode Adapter Contract (redesign-plan/01 section 6):
     id 'blitz' | supportsPause | usesRealTimeCanvasLoop
     init({ seedStr, seed, doctrine, scenario }) | dispose()
     update(dt, now) | render(ctx, view, now)
     onPointerDown / onPointerMove / onPointerUp / onKeyDown
     getHudSnapshot()

   Mechanics (redesign-plan/06):
     1. Exactly 150.0s countdown; hospital overload ends early via window.gameOver('hospital').
     2. Four escalation stages; Surge Alert sweeps the corridor every 25s.
     3. EpiRuntime runs once in init() to compute the Hazard Weight Vector
        (boyolali..gunungkidul); never synchronous during the frame loop.
     4. Precision combo 1.0x -> 5.0x with a 2.2s decay timer; bites drop -1 tier.
        Containment Spray charges +6% per kill / +15% per drained pool
        (x1.2 under rapid_response_corps); Space / Right-Click / HUD trigger
        fires an expanding mist shockwave at the cursor / last tap.
     5. Three clickable tactical crates drop every 18-22s (24px pulsing vector),
        vanish after 7s: Triage Relief (-35 ICU + 3s freeze), Larvicide Overdrive
        (drain all pools + 8s spawn freeze), Cryo-Radar Slow (45% slow, 5s).
     6. SFX pitch climbs the C5 D5 E5 G5 A5 C6 pentatonic ladder with combo tier;
        bass pulse active at tier 4x+ via audio.js music layer.
     9. Instant replay: getHudSnapshot().replay = { seedStr, doctrine, scenario }.

   Headless-safe: no window/document access at module scope; all browser calls
   are guarded so bare `node -e "import(...)"` smoke tests pass.
   ============================================================================ */

import {
  mulberry32,
  parseSeed,
  randomSeedWord,
  GAME_RULES,
  getG,
  setG,
} from '../state.js';
import {
  EpiRuntime,
  DISTRICT_DEFS,
  RIVERS,
  buildDistrict,
  districtAt,
  riskOf,
} from '../epi-engine.js';
import { MODEL_DATA } from '../epi-data.js';
import {
  drawMapBackground,
  drawMerapiContour,
  drawRiverCurves,
  drawDistrictPolygon,
  drawHotspotNode,
  drawStandingPool,
  drawMosquitoSprite,
  drawSlashTrail,
  drawSprayBurst,
} from '../sprites.js';
import { getView, CORRIDOR, FX } from '../map-renderer.js';
import { SFX } from '../audio.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = v => clamp(Number(v) || 0, 0, 1);
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const COMBO_MULTS = Object.freeze([1.0, 1.5, 2.0, 3.0, 4.0, 5.0]);
const COMBO_DECAY_SEC = 2.2;
const SWATS_PER_TIER = 4;
const BLITZ_DURATION = 150.0;
const SPRAY_RADIUS = 95;          // map units
const SPRAY_KILL_BONUS = 1.5;     // multi-kill score factor
const SWAT_RADIUS = 17;           // map units (x swatRadiusFactor for RRC)
const POOL_TAP_RADIUS = 15;
const CRATE_TAP_RADIUS = 16;
const CRATE_TTL_SEC = 7;
const SURGE_INTERVAL_SEC = 25;

const STAGES = Object.freeze([
  Object.freeze({ stage: 1, label: 'FIRST MONSOON FRONT', until: 115 }),  // 02:30-01:55
  Object.freeze({ stage: 2, label: 'RIVERBANK ESCALATION', until: 75 }),  // 01:55-01:15
  Object.freeze({ stage: 3, label: 'CORRIDOR OUTBREAK', until: 35 }),     // 01:15-00:35
  Object.freeze({ stage: 4, label: 'FINAL 30s', until: 0 }),              // 00:35-00:00
]);

const ARCHETYPE = Object.freeze({
  standard: Object.freeze({ hp: 1, speed: 26, damage: 7, score: 50 }),
  flanker:  Object.freeze({ hp: 1, speed: 44, damage: 5, score: 70 }),
  queen:    Object.freeze({ hp: 2, speed: 15, damage: 12, score: 150 }),
  viremic:  Object.freeze({ hp: 1, speed: 30, damage: 14, score: 120 }), // 2x ICU damage
});

const STAGE_SPAWN_INTERVAL = Object.freeze({ 1: 1.5, 2: 1.15, 3: 0.85, 4: 0.58 });
const STAGE_POOL_INTERVAL = Object.freeze({ 1: 8.5, 2: 6.0, 3: 6.5, 4: 7.5 });

/* Fire the shell-provided game-over hook; degrade gracefully headless or when
   the shell has not registered one yet (CustomEvent fallback, per contract). */
function fireGameOver(reason) {
  if (typeof window === 'undefined') return;
  try {
    if (typeof window.gameOver === 'function') { window.gameOver(reason); return; }
  } catch (e) { /* fall through to CustomEvent */ }
  try { window.dispatchEvent(new CustomEvent('dd:gameover', { detail: { reason } })); } catch (e) { /* no DOM */ }
  if (typeof window.gameOver !== 'function') {
    window.gameOver = function shellGameOver(r) {
      try { window.dispatchEvent(new CustomEvent('dd:gameover', { detail: { reason: r } })); } catch (e) { /* noop */ }
    };
  }
}

/* Hazard Weight Vector (boyolali..gunungkidul), computed once in init().
   Normalized to mean 1.0, clamped [0.45, 2.2]. Falls back to baseline-cases
   proxy if inference is unavailable (e.g. headless harness without weights). */
function computeHazardWeights(districts) {
  const weights = {};
  try {
    const model = EpiRuntime.create(MODEL_DATA);
    const forecasts = model.predictAll(0);
    const raw = {};
    let sum = 0;
    for (const def of DISTRICT_DEFS) {
      const outlook = forecasts[def.id];
      const head = outlook && outlook[0];
      const mu = head && Number.isFinite(head.mu) ? head.mu : Math.max(1, def.cases || 1);
      raw[def.id] = Math.max(0.05, mu);
      sum += raw[def.id];
    }
    const mean = sum / DISTRICT_DEFS.length;
    for (const def of DISTRICT_DEFS) weights[def.id] = clamp(raw[def.id] / mean, 0.45, 2.2);
    // Attach a coarse risk tier for choropleth tinting.
    for (const d of districts) {
      const outlook = forecasts[d.id];
      const head = outlook && outlook[0];
      d.risk = head && Number.isFinite(head.mu) && Number.isFinite(head.threshold) && head.threshold > 0
        ? riskOf(head.mu, head.threshold)
        : (weights[d.id] > 1.5 ? 3 : weights[d.id] > 1.15 ? 2 : weights[d.id] > 0.8 ? 1 : 0);
    }
    return { weights, source: 'epi' };
  } catch (err) {
    const raw = {};
    let sum = 0;
    for (const def of DISTRICT_DEFS) { raw[def.id] = Math.max(1, def.cases || 1); sum += raw[def.id]; }
    const mean = sum / DISTRICT_DEFS.length;
    for (const def of DISTRICT_DEFS) weights[def.id] = clamp(raw[def.id] / mean, 0.45, 2.2);
    for (const d of districts) {
      const w = weights[d.id];
      d.risk = w > 1.5 ? 3 : w > 1.15 ? 2 : w > 0.8 ? 1 : 0;
    }
    return { weights, source: 'fallback' };
  }
}

function pickWeightedDistrict(districts, weights, rng, restrictIds) {
  let pool = districts;
  if (Array.isArray(restrictIds) && restrictIds.length) {
    const narrowed = districts.filter(d => restrictIds.includes(d.id));
    if (narrowed.length) pool = narrowed;
  }
  let total = 0;
  for (const d of pool) total += Math.max(0.05, weights[d.id] ?? 1);
  let roll = rng() * total;
  for (const d of pool) {
    roll -= Math.max(0.05, weights[d.id] ?? 1);
    if (roll <= 0) return d;
  }
  return pool[pool.length - 1];
}

function randomInteriorPoint(district, rng) {
  if (district && Array.isArray(district.pts) && district.pts.length) {
    const p = district.pts[(rng() * district.pts.length) | 0];
    return { x: p[0], y: p[1] };
  }
  const c = district?.c || [CORRIDOR.WIDTH / 2, CORRIDOR.HEIGHT / 2];
  return { x: c[0] + (rng() - 0.5) * 20, y: c[1] + (rng() - 0.5) * 20 };
}

function formatClock(t) {
  const s = Math.max(0, t);
  const mm = Math.floor(s / 60);
  const ss = s - mm * 60;
  return `${String(mm).padStart(2, '0')}:${ss < 10 ? '0' : ''}${ss.toFixed(1)}`;
}

function stageFor(timeLeft) {
  if (timeLeft > 115) return STAGES[0];
  if (timeLeft > 75) return STAGES[1];
  if (timeLeft > 35) return STAGES[2];
  return STAGES[3];
}

const BlitzMode = {
  id: 'blitz',
  supportsPause: true,
  usesRealTimeCanvasLoop: true,

  /* ---------------- lifecycle ---------------- */

  init({ seedStr, seed, doctrine, scenario } = {}) {
    this.dispose();

    const str = (typeof seedStr === 'string' && seedStr.trim()) ? seedStr.trim()
      : (seed !== undefined && seed !== null ? String(seed) : randomSeedWord());
    const seedNum = Number.isFinite(seed) ? (seed >>> 0) : parseSeed(str);
    const mapRng = mulberry32(parseSeed(str + '/blitz-map'));

    this.seedStr = str;
    this.seed = seedNum;
    this.doctrine = typeof doctrine === 'string' ? doctrine : null;
    this.scenario = typeof scenario === 'string' && scenario ? scenario : 'solo_blitz';
    this.rng = mulberry32(seedNum ^ 0x9e3779b9);

    // Doctorine modifiers (rapid_response_corps: +40 ICU, +20% spray, +18% swat radius)
    this.isRapidResponse = this.doctrine === 'rapid_response_corps';
    this.sprayChargeFactor = this.isRapidResponse ? 1.2 : 1.0;
    this.swatRadiusFactor = this.isRapidResponse ? 1.18 : 1.0;

    this.districts = DISTRICT_DEFS.map(def => buildDistrict(def, mapRng));
    const hazard = computeHazardWeights(this.districts);
    this.hazardWeights = hazard.weights;
    this.hazardSource = hazard.source;
    // Stage 2 hotspot pulse targets: two hottest districts (boyolali..gunungkidul order kept)
    this.hotspotIds = Object.keys(this.hazardWeights)
      .sort((a, b) => this.hazardWeights[b] - this.hazardWeights[a])
      .slice(0, 2);

    // Run state
    this.phase = 'playing';
    this.timeLeft = BLITZ_DURATION;
    this.survivalTime = 0;
    this.hospitalCap = this.isRapidResponse ? 280 : GAME_RULES.careSlots;
    this.hospitalLoad = 0;
    this.peakLoad = 0;
    this.score = 0;

    // Combo
    this.comboStreak = 0;
    this.comboTierIndex = 0;
    this.comboTimer = 0;
    this.peakCombo = 1.0;
    this.comboPeakTier = 0;

    // Spray
    this.sprayCharge = 0;
    this.sprayDenied = 0;

    // Entities
    this.mosquitoes = [];
    this.pools = [];
    this.crates = [];
    this.sprayBursts = [];
    this.slashTrail = [];
    this.mosquitoId = 0;
    this.crateId = 0;

    // Timers
    this.spawnTimer = 0.8;
    this.poolTimer = 6.0;
    this.crateTimer = 10.0;
    this.surgeTimer = SURGE_INTERVAL_SEC;
    this.commuterTimer = 8.0;
    this.corridorLeg = 0;
    this.hospitalFreeze = 0;
    this.slowTimer = 0;
    this.poolFreeze = 0;
    this.shake = 0;
    this.surgeAnim = 0;
    this.surgeAlertT = 0;
    this.surgeCount = 0;
    this.surgeLabel = '';

    // Run statistics
    this.bites = 0;
    this.kills = 0;
    this.poolsDrained = 0;
    this.cratesCollected = 0;
    this.queensDown = 0;

    // End-of-run results
    this.grade = null;
    this.victory = false;
    this.endReason = null;
    this.clearBonus = 0;
    this.unusedBedCapacity = 0;

    this.stage = stageFor(this.timeLeft);
    this.final30 = this.stage.stage === 4;
    this.fx = new FX();
    this.lastPointer = { x: CORRIDOR.WIDTH / 2, y: CORRIDOR.HEIGHT / 2 };
    this.pointerDown = false;

    // Mirror into shared G (window.G for the shell + E2E hooks)
    const g = getG() && typeof getG() === 'object' ? getG() : {};
    setG(Object.assign(g, {
      mode: 'blitz',
      doctrine: this.doctrine,
      scenario: this.scenario,
      seedStr: this.seedStr,
      phase: 'blitz',
      score: 0,
      hospitalLoad: 0,
      hospitalCap: this.hospitalCap,
      timeLeft: this.timeLeft,
      comboTier: COMBO_MULTS[0],
      stage: this.stage.stage,
      districts: this.districts,
      totals: Object.assign({ swats: 0, bites: 0, auto: 0, bestCombo: 0, queens: 0, drained: 0, feverCount: 0, cases: 0, baseline: 0 }, g.totals || {}),
      blitz: {
        grade: null, victory: false, endReason: null,
        peakCombo: this.peakCombo, peakLoad: 0, hazardSource: this.hazardSource,
      },
    }));

    try { SFX.init(); SFX.setComboPitch(0); SFX.startMusic(); SFX.play('wave'); } catch (e) { /* audio optional */ }

    this._banner('OUTBREAK BLITZ — 02:30', '#F59E0B');
    return this;
  },

  dispose() {
    this.phase = 'disposed';
    this.mosquitoes = [];
    this.pools = [];
    this.crates = [];
    this.sprayBursts = [];
    this.slashTrail = [];
    if (this.fx && typeof this.fx.clear === 'function') this.fx.clear();
    this.pointerDown = false;
    try { SFX.stopMusic(); SFX.setComboPitch(0); } catch (e) { /* audio optional */ }
    return this;
  },

  /* ---------------- internal helpers ---------------- */

  _banner(text, color = '#F59E0B', size = 17) {
    if (!this.fx) return;
    this.fx.floatText(CORRIDOR.WIDTH / 2, 64, text, {
      color, size, life: 1700, now: nowMs(),
    });
  },

  _float(x, y, text, color = '#E6F0F2', size = 12, life = 900) {
    if (!this.fx) return;
    this.fx.floatText(x, y, text, { color, size, life, now: nowMs() });
  },

  _comboMult() { return COMBO_MULTS[this.comboTierIndex] || 1.0; },

  _scoreFactor(viaSpray = false) {
    return this._comboMult() * (this.final30 ? 2 : 1) * (viaSpray ? SPRAY_KILL_BONUS : 1);
  },

  _addScore(base, viaSpray = false) {
    const pts = Math.max(0, Math.round(base * this._scoreFactor(viaSpray)));
    this.score += pts;
    return pts;
  },

  _bumpCombo() {
    this.comboStreak += 1;
    this.comboTimer = COMBO_DECAY_SEC;
    const newTier = Math.min(COMBO_MULTS.length - 1, Math.floor(this.comboStreak / SWATS_PER_TIER));
    if (newTier !== this.comboTierIndex) {
      this.comboTierIndex = newTier;
      const mult = this._comboMult();
      if (mult > this.peakCombo) { this.peakCombo = mult; this.comboPeakTier = newTier; }
      try { SFX.setComboPitch(this.comboTierIndex); SFX.play('combo'); } catch (e) { /* audio optional */ }
      return true; // tier raised
    }
    return false;
  },

  _breakComboTier() {
    // A bite costs exactly one tier (never a full wipe)
    this.comboTierIndex = Math.max(0, this.comboTierIndex - 1);
    this.comboStreak = this.comboTierIndex * SWATS_PER_TIER;
    try { SFX.setComboPitch(this.comboTierIndex); } catch (e) { /* audio optional */ }
  },

  _chargeSpray(amount) {
    this.sprayCharge = clamp(this.sprayCharge + amount * this.sprayChargeFactor, 0, 100);
  },

  _weightedTarget() {
    return pickWeightedDistrict(this.districts, this.hazardWeights, this.rng, null);
  },

  _weightedSpawnDistrict() {
    // Stage 1 seeds surakarta+klaten; later stages open the whole corridor.
    if (this.stage && this.stage.stage === 1) {
      return pickWeightedDistrict(this.districts, this.hazardWeights, this.rng, ['surakarta', 'klaten']);
    }
    return this._weightedTarget();
  },

  _pickArchetype() {
    const s = this.stage ? this.stage.stage : 1;
    const r = this.rng();
    if (s === 1) return 'standard';
    if (s === 2) return r < 0.68 ? 'standard' : 'flanker';
    if (s === 3) return r < 0.45 ? 'standard' : r < 0.65 ? 'flanker' : r < 0.82 ? 'queen' : 'viremic';
    return r < 0.40 ? 'standard' : r < 0.62 ? 'flanker' : r < 0.80 ? 'queen' : 'viremic';
  },

  _spawnMosquito(archetype, fromDistrict, targetDistrict) {
    if (this.mosquitoes.length >= 60) return null;
    const proto = ARCHETYPE[archetype] || ARCHETYPE.standard;
    const src = fromDistrict || this._weightedSpawnDistrict();
    const dst = targetDistrict || this._weightedTarget();
    const pos = randomInteriorPoint(src, this.rng);
    const m = {
      id: ++this.mosquitoId,
      archetype,
      x: pos.x,
      y: pos.y,
      hp: proto.hp,
      maxHp: proto.hp,
      speed: proto.speed,
      damage: proto.damage,
      baseScore: proto.score,
      targetId: dst.id,
      angle: 0,
      wobble: this.rng() * TAU,
      wobbleAmp: archetype === 'flanker' ? 9 : archetype === 'queen' ? 2.5 : 5,
      wobbleFreq: archetype === 'flanker' ? 5.2 : 2.6,
      age: 0,
    };
    this.mosquitoes.push(m);
    return m;
  },

  _spawnPool(atPoint) {
    if (this.poolFreeze > 0) return null;
    const d = this._weightedSpawnDistrict();
    const pos = atPoint || randomInteriorPoint(d, this.rng);
    const pool = {
      id: `pool-${(this.pools.length + 1)}-${(this.poolSeq = (this.poolSeq || 0) + 1)}`,
      x: pos.x, y: pos.y,
      drain: 0,
      seed: (this.rng() * 1000) | 0,
      districtId: d ? d.id : null,
    };
    this.pools.push(pool);
    return pool;
  },

  _spawnCrate() {
    // Threatened district: pick randomly among the two hottest.
    const hot = this.hotspotIds.slice();
    const targetId = hot.length ? hot[(this.rng() * hot.length) | 0] : this.districts[0].id;
    const d = this.districts.find(x => x.id === targetId) || this.districts[0];
    const pos = randomInteriorPoint(d, this.rng);
    const roll = this.rng();
    const type = roll < 1 / 3 ? 'triage' : roll < 2 / 3 ? 'larvicide' : 'cryo';
    const crate = {
      id: ++this.crateId,
      type,
      x: pos.x, y: pos.y,
      districtId: d.id,
      born: nowMs(),
      ttl: CRATE_TTL_SEC,
      age: 0,
    };
    this.crates.push(crate);
    this._float(pos.x, pos.y - 18, 'SUPPLY DROP', '#FBBF24', 11, 1400);
    return crate;
  },

  _nextCrateDelay() {
    // Stage 4 (FINAL 30s): Golden/Bio-Boost crates drop more frequently.
    if (this.final30) return 12 + this.rng() * 4;
    return 18 + this.rng() * 4;
  },

  _spawnInterval() {
    const base = STAGE_SPAWN_INTERVAL[this.stage.stage] ?? 1.2;
    // Active breeding pools accelerate spawn ticks unless drained.
    const poolBoost = 1 + 0.15 * this.pools.length;
    const rate = this.stage.stage === 4 ? 1.6 : 1.0; // FINAL 30s: 1.6x spawn rate
    return base / (poolBoost * rate);
  },

  _poolInterval() {
    return STAGE_POOL_INTERVAL[this.stage.stage] ?? 8.0;
  },

  _doSurge(label) {
    this.surgeCount += 1;
    this.surgeAnim = 1.4;
    this.surgeAlertT = 3.0;
    this.surgeLabel = label || 'SURGE ALERT';
    // Surge burst: a coordinated push across the corridor
    const burst = this.stage.stage >= 3 ? 3 : 2;
    for (let i = 0; i < burst; i++) this._spawnMosquito(this._pickArchetype());
    this._banner(this.surgeLabel, '#FBBF24', 15);
    try { SFX.play('wave'); } catch (e) { /* audio optional */ }
  },

  _hitMosquito(m, hitX, hitY) {
    const raised = this._bumpCombo();
    m.hp -= 1;
    if (m.hp > 0) {
      // Queen survives the first swat: knockback + hit feedback
      const ang = Math.atan2(m.y - hitY, m.x - hitX) || this.rng() * TAU;
      m.x += Math.cos(ang) * 7;
      m.y += Math.sin(ang) * 7;
      this._float(m.x, m.y - 12, 'HIT', '#FDE68A', 11, 650);
      try { SFX.play('hit'); } catch (e) { /* audio optional */ }
      return;
    }
    this._killMosquito(m, { viaSpray: false, raisedCombo: raised });
  },

  _killMosquito(m, { viaSpray = false } = {}) {
    const idx = this.mosquitoes.indexOf(m);
    if (idx === -1) return 0;
    this.mosquitoes.splice(idx, 1);
    this.kills += 1;
    if (m.archetype === 'queen') { this.queensDown += 1; }
    const pts = this._addScore(m.baseScore, viaSpray);
    if (!viaSpray) this._chargeSpray(6);
    // FX: sparks + splat + score text
    try {
      if (this.fx) {
        this.fx.burst(m.x, m.y, { color: m.archetype === 'viremic' ? '#F87171' : '#7DD3FC', count: 12, speed: 80 });
        this.fx.splat(m.x, m.y, { color: m.archetype === 'queen' ? '#D946EF' : '#EF4444', size: m.archetype === 'queen' ? 13 : 9 });
      }
    } catch (e) { /* FX optional */ }
    this._float(m.x, m.y - 10, `+${pts}`, viaSpray ? '#FBBF24' : '#E6F0F2', 12, 850);
    try { SFX.play(viaSpray ? 'zap' : 'swat'); } catch (e) { /* audio optional */ }
    // Mirror totals
    const G = getG();
    if (G && G.totals) {
      G.totals.swats = (G.totals.swats || 0) + 1;
      G.totals.bestCombo = Math.max(G.totals.bestCombo || 0, this.peakCombo);
      if (m.archetype === 'queen') G.totals.queens = (G.totals.queens || 0) + 1;
    }
    return pts;
  },

  _bite(m) {
    const idx = this.mosquitoes.indexOf(m);
    if (idx !== -1) this.mosquitoes.splice(idx, 1);

    if (this.hospitalFreeze > 0) {
      this._float(m.x, m.y - 8, 'ICU FROZEN', '#34D399', 11, 800);
      return;
    }
    this.hospitalLoad += m.damage;
    this.bites += 1;
    this.peakLoad = Math.max(this.peakLoad, this.hospitalLoad);
    this._breakComboTier();
    this.shake = Math.max(this.shake, 0.35);
    this._float(m.x, m.y - 8, `BITE -${m.damage} ICU`, '#F87171', 12, 1000);
    try { SFX.play('bite'); } catch (e) { /* audio optional */ }
    // Brood Queen bite seeds a fresh breeding pool
    if (m.archetype === 'queen') {
      this._spawnPool({ x: m.x, y: m.y });
      this._float(m.x, m.y + 12, 'QUEEN SEEDED A POOL', '#E879F9', 10, 1100);
    }
    const G = getG();
    if (G) {
      G.hospitalLoad = this.hospitalLoad;
      if (G.totals) G.totals.bites = (G.totals.bites || 0) + 1;
    }
  },

  _drainPool(pool, awardScore = true) {
    const idx = this.pools.indexOf(pool);
    if (idx === -1) return 0;
    this.pools.splice(idx, 1);
    this.poolsDrained += 1;
    this.comboTimer = COMBO_DECAY_SEC; // pool completion resets the decay timer
    this._chargeSpray(15);
    const pts = awardScore ? this._addScore(150, false) : 0;
    if (awardScore) this._float(pool.x, pool.y - 10, `+${pts} POOL CLEARED`, '#38BDF8', 11, 1000);
    try { SFX.play('drain'); } catch (e) { /* audio optional */ }
    const G = getG();
    if (G && G.totals) G.totals.drained = (G.totals.drained || 0) + 1;
    return pts;
  },

  _collectCrate(crate) {
    const idx = this.crates.indexOf(crate);
    if (idx === -1) return;
    this.crates.splice(idx, 1);
    this.cratesCollected += 1;
    this.score += 100; // flat field-assist bonus (not combo-scaled)
    if (crate.type === 'triage') {
      this.hospitalLoad = Math.max(0, this.hospitalLoad - 35);
      this.hospitalFreeze = Math.max(this.hospitalFreeze, 3.0);
      this._float(crate.x, crate.y - 12, '-35 ICU — HOSPITAL FREEZE', '#34D399', 12, 1300);
      try { SFX.play('heal'); } catch (e) { /* audio optional */ }
    } else if (crate.type === 'larvicide') {
      const drained = this.pools.slice();
      for (const p of drained) this._drainPool(p, true);
      this.poolFreeze = Math.max(this.poolFreeze, 8.0);
      this._float(crate.x, crate.y - 12, 'LARVICIDE OVERDRIVE', '#FBBF24', 12, 1300);
      try { SFX.play('fog'); } catch (e) { /* audio optional */ }
    } else { // cryo
      this.slowTimer = Math.max(this.slowTimer, 5.0);
      this._float(crate.x, crate.y - 12, 'CRYO-RADAR SLOW', '#67E8F9', 12, 1300);
      try { SFX.play('zap'); } catch (e) { /* audio optional */ }
    }
    const G = getG();
    if (G) G.hospitalLoad = this.hospitalLoad;
  },

  fireSpray(atPoint) {
    if (this.phase !== 'playing') return false;
    const p = atPoint && Number.isFinite(atPoint.x) && Number.isFinite(atPoint.y)
      ? atPoint : this.lastPointer;
    if (this.sprayCharge < 100) {
      this.sprayDenied = 0.7;
      try { SFX.play('deny'); } catch (e) { /* audio optional */ }
      this._float(p.x, p.y - 14, 'SPRAY NOT CHARGED', '#F87171', 10, 750);
      return false;
    }
    this.sprayCharge = 0;
    this.sprayBursts.push({ x: p.x, y: p.y, progress: 0, maxRadius: SPRAY_RADIUS });
    const victims = this.mosquitoes.filter(m => dist(m.x, m.y, p.x, p.y) <= SPRAY_RADIUS);
    let kills = 0;
    // Copy: _killMosquito mutates the live array
    for (const m of victims.slice()) {
      const pts = this._killMosquito(m, { viaSpray: true });
      if (pts > 0) kills += 1;
    }
    if (kills >= 3) this._float(p.x, p.y - 20, 'SWARM PURGED!', '#FBBF24', 17, 1400);
    else this._float(p.x, p.y - 20, 'SPRAY BURST', '#38BDF8', 13, 1000);
    // Spray purge resets the combo decay timer but does not build streak
    if (kills > 0) this.comboTimer = COMBO_DECAY_SEC;
    try { SFX.play('spray'); } catch (e) { /* audio optional */ }
    return true;
  },

  /* ---------------- update ---------------- */

  update(dt, now) {
    if (this.phase !== 'playing') return;
    const step = clamp(Number(dt) || 0, 0, 0.1); // clamp huge tab-switch deltas
    this.survivalTime += step;
    this.timeLeft = Math.max(0, this.timeLeft - step);

    // Timers
    this.hospitalFreeze = Math.max(0, this.hospitalFreeze - step);
    this.slowTimer = Math.max(0, this.slowTimer - step);
    this.poolFreeze = Math.max(0, this.poolFreeze - step);
    this.sprayDenied = Math.max(0, this.sprayDenied - step);
    this.surgeAlertT = Math.max(0, this.surgeAlertT - step);
    this.surgeAnim = Math.max(0, this.surgeAnim - step);
    this.shake = Math.max(0, this.shake - step);

    // Combo decay
    if (this.comboTimer > 0) {
      this.comboTimer = Math.max(0, this.comboTimer - step);
      if (this.comboTimer === 0 && (this.comboStreak > 0 || this.comboTierIndex > 0)) {
        this.comboStreak = 0;
        this.comboTierIndex = 0;
        try { SFX.setComboPitch(0); } catch (e) { /* audio optional */ }
      }
    }

    // Stage resolution (monotonic escalation)
    const nextStage = stageFor(this.timeLeft);
    if (nextStage.stage !== this.stage.stage) {
      this.stage = nextStage;
      this.final30 = nextStage.stage === 4;
      this._banner(nextStage.stage === 4 ? 'FINAL 30s — RED ALERT' : `SURGE ALERT — ${nextStage.label}`,
        nextStage.stage === 4 ? '#EF4444' : '#FBBF24', 16);
      try { SFX.play('wave'); } catch (e) { /* audio optional */ }
    }

    // Surge Alert sweep every 25s
    this.surgeTimer -= step;
    if (this.surgeTimer <= 0) {
      this.surgeTimer = SURGE_INTERVAL_SEC;
      this._doSurge(`SURGE ALERT — ${this.stage.label}`);
    }

    // Stage 3: commuter surge sleman <-> klaten <-> surakarta
    if (this.stage.stage === 3) {
      this.commuterTimer -= step;
      if (this.commuterTimer <= 0) {
        this.commuterTimer = 8.0;
        const corridor = ['sleman', 'klaten', 'surakarta'];
        const fromId = corridor[this.corridorLeg % corridor.length];
        const toId = corridor[(this.corridorLeg + 1) % corridor.length];
        this.corridorLeg += 1;
        const from = this.districts.find(d => d.id === fromId);
        const to = this.districts.find(d => d.id === toId);
        for (let i = 0; i < 2; i++) this._spawnMosquito('flanker', from, to);
        this._float((from.c[0] + to.c[0]) / 2, (from.c[1] + to.c[1]) / 2, 'COMMUTER SURGE', '#67E8F9', 11, 1200);
      }
    }

    // Spawning
    this.spawnTimer -= step;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = this._spawnInterval();
      this._spawnMosquito(this._pickArchetype());
    }

    // Breeding pools
    this.poolTimer -= step;
    if (this.poolTimer <= 0) {
      this.poolTimer = this._poolInterval();
      this._spawnPool();
    }

    // Tactical supply drops
    this.crateTimer -= step;
    if (this.crateTimer <= 0) {
      this.crateTimer = this._nextCrateDelay();
      this._spawnCrate();
    }

    // Crate lifetimes (7s fuse)
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      c.age += step;
      if (c.age >= c.ttl) {
        this._float(c.x, c.y, 'SUPPLY LOST', '#8FA8B2', 10, 800);
        this.crates.splice(i, 1);
      }
    }

    // Spray bursts (expanding mist shockwave)
    for (let i = this.sprayBursts.length - 1; i >= 0; i--) {
      const b = this.sprayBursts[i];
      b.progress += step / 0.9;
      if (b.progress >= 1) this.sprayBursts.splice(i, 1);
    }

    // Mosquito movement (cryo-slow multiplies speed by 0.55)
    const slowFactor = this.slowTimer > 0 ? 0.55 : 1.0;
    for (let i = this.mosquitoes.length - 1; i >= 0; i--) {
      const m = this.mosquitoes[i];
      m.age += step;
      const target = this.districts.find(d => d.id === m.targetId) || this.districts[0];
      const tx = target.c[0], ty = target.c[1];
      const dx = tx - m.x, dy = ty - m.y;
      const d = Math.hypot(dx, dy);
      if (d < 12) { this._bite(m); continue; }
      const ux = dx / d, uy = dy / d;
      // Sinusoidal weave perpendicular to heading
      const wob = Math.sin(m.age * m.wobbleFreq + m.wobble) * m.wobbleAmp;
      const px = -uy, py = ux;
      const stepLen = m.speed * slowFactor * step;
      m.x += ux * stepLen + px * wob * step * 2.2;
      m.y += uy * stepLen + py * wob * step * 2.2;
      m.angle = Math.atan2(uy, ux) + Math.PI / 2;
    }

    // Peak load + hospital overload check
    this.peakLoad = Math.max(this.peakLoad, this.hospitalLoad);
    if (this.hospitalLoad > this.hospitalCap) { this._endRun(false, 'hospital'); return; }

    // 00:00 resolution
    if (this.timeLeft <= 0) {
      if (this.hospitalLoad <= this.hospitalCap) this._endRun(true, 'clear');
      else this._endRun(false, 'hospital');
      return;
    }

    // Mirror live telemetry into G
    const G = getG();
    if (G) {
      G.score = this.score;
      G.hospitalLoad = this.hospitalLoad;
      G.timeLeft = this.timeLeft;
      G.stage = this.stage.stage;
      G.comboTier = this._comboMult();
      if (G.blitz) { G.blitz.peakCombo = this.peakCombo; G.blitz.peakLoad = this.peakLoad; }
    }
  },

  _endRun(victory, reason) {
    if (this.phase !== 'playing') return;
    this.phase = 'over';
    this.victory = victory;
    this.endReason = reason;
    this.survivalTime = BLITZ_DURATION - this.timeLeft;

    if (victory) {
      this.unusedBedCapacity = Math.max(0, Math.round(this.hospitalCap - this.hospitalLoad));
      this.clearBonus = 1500 + 25 * this.unusedBedCapacity;
      this.score += this.clearBonus;
    } else {
      this.unusedBedCapacity = 0;
      this.clearBonus = 0;
    }

    // Grading
    if (victory) {
      if (this.bites === 0 && this.peakCombo >= 4.0) this.grade = 'S';
      else if (this.peakLoad < 0.6 * this.hospitalCap) this.grade = 'A';
      else this.grade = 'B';
    } else {
      this.grade = this.survivalTime >= 90 ? 'C' : 'D';
    }

    const G = getG();
    if (G) {
      G.phase = 'over';
      G.score = this.score;
      G.hospitalLoad = this.hospitalLoad;
      G.hospitalCap = this.hospitalCap;
      G.grade = this.grade;
      if (G.blitz) {
        G.blitz.grade = this.grade;
        G.blitz.victory = victory;
        G.blitz.endReason = reason;
        G.blitz.peakCombo = this.peakCombo;
        G.blitz.peakLoad = this.peakLoad;
        G.blitz.clearBonus = this.clearBonus;
      }
      setG(G);
    }

    try { SFX.stopMusic(); SFX.play(victory ? 'win' : 'lose'); } catch (e) { /* audio optional */ }
    this._banner(victory ? 'BLITZ CLEAR — 00:00' : 'HOSPITAL OVERLOAD', victory ? '#10B981' : '#EF4444', 18);
    fireGameOver(victory ? 'clear' : 'hospital');
  },

  /* ---------------- render ---------------- */

  render(ctx, view, now) {
    if (!ctx) return;
    const tNow = now ?? nowMs();
    const t = tNow / 1000;
    const base = getView();
    const v = (view && Number.isFinite(view.scale) && Number.isFinite(view.ox))
      ? Object.assign({}, base, view)
      : base;
    const dpr = Number.isFinite(v.dpr) && v.dpr > 0 ? v.dpr : 1;

    // Screen-space pass: backdrop
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.w, v.h);
    drawMapBackground(ctx, Object.assign({}, v, { time: t }));

    // Map-space pass (corridor transform), with optional impact shake
    const shakeX = this.shake > 0 ? (this.rng() - 0.5) * this.shake * 14 : 0;
    const shakeY = this.shake > 0 ? (this.rng() - 0.5) * this.shake * 14 : 0;
    ctx.setTransform(
      dpr * v.scale, 0, 0, dpr * v.scale,
      dpr * (v.ox - CORRIDOR.MX0 * v.scale + shakeX),
      dpr * (v.oy - CORRIDOR.MY0 * v.scale + shakeY),
    );

    // FINAL 30s: crimson grid shift
    if (this.final30) {
      ctx.save();
      ctx.fillStyle = 'rgba(153, 27, 27, 0.16)';
      ctx.fillRect(0, 0, CORRIDOR.WIDTH, CORRIDOR.HEIGHT);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.55)';
      ctx.lineWidth = 3;
      ctx.strokeRect(2, 2, CORRIDOR.WIDTH - 4, CORRIDOR.HEIGHT - 4);
      ctx.restore();
    }

    drawMerapiContour(ctx, { time: t });
    drawRiverCurves(ctx, RIVERS, t);

    // District choropleth tinted by hazard weight / risk tier.
    // Skipped headless: sprites.js resolveDistrictPath constructs Path2D unguarded.
    if (typeof Path2D !== 'undefined') {
      for (const d of this.districts) {
        drawDistrictPolygon(ctx, d, { time: t, selected: false });
      }
    }

    // Stage 2+: two hotspot districts pulse amber
    if (this.stage && this.stage.stage >= 2) {
      for (const id of this.hotspotIds) {
        const d = this.districts.find(x => x.id === id);
        if (d) drawHotspotNode(ctx, d.c[0], d.c[1], { time: t, color: '#F59E0B', intensity: 0.85 });
      }
    }

    // Surge Alert sweep band
    if (this.surgeAnim > 0) {
      const progress = 1 - this.surgeAnim / 1.4;
      const bx = CORRIDOR.MX0 + progress * CORRIDOR.MW;
      ctx.save();
      const grad = ctx.createLinearGradient(bx - 70, 0, bx, 0);
      grad.addColorStop(0, 'rgba(245, 158, 11, 0)');
      grad.addColorStop(1, `rgba(245, 158, 11, ${0.32 * (1 - progress) + 0.08})`);
      ctx.fillStyle = grad;
      ctx.fillRect(bx - 70, CORRIDOR.MY0, 70, CORRIDOR.MH);
      ctx.restore();
    }

    // Standing water breeding pools
    for (const p of this.pools) {
      drawStandingPool(ctx, p.x, p.y, {
        rx: 10, ry: 6.8, seed: p.seed, drain: clamp01(p.drain), time: t,
      });
    }

    // Tactical supply crates (24px pulsing vector icon, 7s fuse)
    for (const c of this.crates) {
      this._drawCrate(ctx, c, t);
    }

    // Mosquitoes
    for (const m of this.mosquitoes) {
      const spec = ARCHETYPE[m.archetype] || ARCHETYPE.standard;
      const w = this.hazardWeights[m.targetId] ?? 1;
      const halo = m.archetype === 'standard' ? clamp01((w - 0.9) / 1.6 + 0.25) : 0;
      drawMosquitoSprite(ctx, m.x, m.y, {
        archetype: m.archetype,
        angle: m.angle,
        time: t + m.wobble,
        hp: m.hp,
        maxHp: m.maxHp,
        halo,
        locked: m.archetype === 'viremic',
      });
    }

    // Swat slash trail (cyan-white plasma sweep)
    if (this.slashTrail.length >= 2) {
      drawSlashTrail(ctx, this.slashTrail, { now: tNow, lifetime: 180, width: 7 });
    }
    // Prune faded slash points
    while (this.slashTrail.length && tNow - this.slashTrail[0].t > 180) this.slashTrail.shift();

    // Containment spray bursts (expanding mist shockwave)
    for (const b of this.sprayBursts) {
      const eased = 1 - Math.pow(1 - clamp01(b.progress), 3);
      drawSprayBurst(ctx, b.x, b.y, eased, {
        maxRadius: b.maxRadius || SPRAY_RADIUS,
        color: '#38BDF8',
        mist: 16,
      });
    }

    // Floating combat text / sparks
    if (this.fx) this.fx.draw(ctx, tNow);

    // Restore screen-space transform for any subsequent HUD compositing
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  _drawCrate(ctx, crate, t) {
    const pulse = 1 + 0.16 * Math.sin(t * 6 + crate.id);
    const ttlFrac = clamp01(1 - crate.age / (crate.ttl || CRATE_TTL_SEC));
    const palette = crate.type === 'triage'
      ? { ring: '#34D399', body: '#065F46', glyph: '#A7F3D0' }
      : crate.type === 'larvicide'
        ? { ring: '#FBBF24', body: '#78350F', glyph: '#FDE68A' }
        : { ring: '#67E8F9', body: '#164E63', glyph: '#CFFAFE' };

    ctx.save();
    ctx.translate(crate.x, crate.y);
    // Pulse ring (24px footprint)
    ctx.globalAlpha = 0.75 + 0.25 * Math.sin(t * 6 + crate.id);
    ctx.strokeStyle = palette.ring;
    ctx.lineWidth = 2;
    ctx.shadowColor = palette.ring;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(0, 0, 12 * pulse, 0, TAU);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    // Body (rounded diamond crate)
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = palette.body;
    ctx.strokeStyle = palette.ring;
    ctx.lineWidth = 1.4;
    const s = 7.4 * pulse;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(-s, -s, s * 2, s * 2, 3);
    else ctx.rect(-s, -s, s * 2, s * 2);
    ctx.fill();
    ctx.stroke();
    ctx.rotate(-Math.PI / 4);
    // Glyph
    ctx.strokeStyle = palette.glyph;
    ctx.fillStyle = palette.glyph;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (crate.type === 'triage') {
      // Clinic cross
      ctx.beginPath(); ctx.moveTo(0, -4.6); ctx.lineTo(0, 4.6); ctx.moveTo(-4.6, 0); ctx.lineTo(4.6, 0); ctx.stroke();
    } else if (crate.type === 'larvicide') {
      // Ovitrap hexagon + droplet
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU - Math.PI / 2;
        const px = Math.cos(a) * 5.2, py = Math.sin(a) * 5.2;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0.8, 1.7, 0, TAU); ctx.fill();
    } else {
      // Cryo radar dish: arcs + feed dot
      ctx.beginPath(); ctx.arc(0, 2.2, 5.4, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 2.2, 3.0, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -3.4, 1.2, 0, TAU); ctx.fill();
    }
    // Fuse arc (remaining lifetime)
    ctx.strokeStyle = ttlFrac > 0.3 ? '#E6F0F2' : '#F87171';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(0, 0, 15.5, -Math.PI / 2, -Math.PI / 2 + TAU * ttlFrac);
    ctx.stroke();
    ctx.restore();
  },

  /* ---------------- pointer input (map coordinates) ---------------- */

  onPointerDown(pt, ev) {
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    this.lastPointer = { x: pt.x, y: pt.y };
    if (this.phase !== 'playing') return;

    // Right-click fires the Containment Spray at the cursor
    if (ev && ev.button === 2) { this.fireSpray({ x: pt.x, y: pt.y }); return; }

    this.pointerDown = true;
    const t = nowMs();
    this.slashTrail.push({ x: pt.x, y: pt.y, t });
    if (this.slashTrail.length > 12) this.slashTrail.shift();

    // 1) Tactical supply crates take priority
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      if (dist(pt.x, pt.y, c.x, c.y) <= CRATE_TAP_RADIUS) { this._collectCrate(c); return; }
    }

    // 2) Drain breeding pools (tap to siphon)
    for (const p of this.pools.slice()) {
      if (dist(pt.x, pt.y, p.x, p.y) <= POOL_TAP_RADIUS) {
        p.drain = clamp01(p.drain + 0.34);
        if (p.drain >= 1) this._drainPool(p, true);
        else {
          this.comboTimer = COMBO_DECAY_SEC;
          this._float(p.x, p.y - 8, 'SIPHONING', '#7DD3FC', 9, 500);
          try { SFX.play('tap'); } catch (e) { /* audio optional */ }
        }
        return;
      }
    }

    // 3) Swat the nearest mosquito in range
    const radius = SWAT_RADIUS * this.swatRadiusFactor;
    let best = null, bestD = radius;
    for (const m of this.mosquitoes) {
      const d = dist(pt.x, pt.y, m.x, m.y);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best) {
      this._hitMosquito(best, pt.x, pt.y);
    } else {
      try { SFX.play('slice'); } catch (e) { /* audio optional */ }
    }
  },

  onPointerMove(pt, ev) {
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    this.lastPointer = { x: pt.x, y: pt.y };
    if (!this.pointerDown || this.phase !== 'playing') return;
    const t = nowMs();
    const last = this.slashTrail[this.slashTrail.length - 1];
    if (!last || dist(pt.x, pt.y, last.x, last.y) > 3 || t - last.t > 40) {
      this.slashTrail.push({ x: pt.x, y: pt.y, t });
      if (this.slashTrail.length > 12) this.slashTrail.shift();
    }
  },

  onPointerUp(pt, ev) {
    this.pointerDown = false;
    if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
      this.lastPointer = { x: pt.x, y: pt.y };
    }
  },

  onKeyDown(ev) {
    if (!ev) return;
    const code = ev.code || ev.key || '';
    if (code === 'Space' || code === ' ' || code === 'Spacebar') {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      this.fireSpray(this.lastPointer);
    }
    // Escape / KeyP are owned by the shell (pause). No mode-level handling.
  },

  /* ---------------- HUD snapshot ---------------- */

  getHudSnapshot() {
    const mult = this._comboMult();
    const cap = this.hospitalCap || GAME_RULES.careSlots;
    const load = this.hospitalLoad || 0;
    const over = this.phase === 'over';
    return {
      phase: 'blitz',
      mode: 'blitz',
      status: this.phase,            // 'playing' | 'over' | 'disposed'
      timeLeft: Math.max(0, this.timeLeft),
      timeLeftStr: formatClock(this.timeLeft),
      survivalTime: this.survivalTime,
      hospitalLoad: load,
      hospitalCap: cap,
      hospitalPct: cap > 0 ? clamp01(load / cap) : 0,
      hospitalFrozen: this.hospitalFreeze > 0,
      hospitalFreezeTimer: this.hospitalFreeze,
      score: this.score,
      comboTier: mult,
      comboTierIndex: this.comboTierIndex,
      comboTierMax: COMBO_MULTS[COMBO_MULTS.length - 1],
      comboStreak: this.comboStreak,
      comboTimer: this.comboTimer,
      comboTimerMax: COMBO_DECAY_SEC,
      comboLabel: `x${mult.toFixed(1)} COMBO`,
      peakCombo: this.peakCombo,
      sprayCharge: this.sprayCharge,
      sprayReady: this.sprayCharge >= 100,
      sprayDenied: this.sprayDenied > 0,
      stage: this.stage ? this.stage.stage : 1,
      stageLabel: this.stage ? this.stage.label : STAGES[0].label,
      final30: !!this.final30,
      peakLoad: this.peakLoad,
      bites: this.bites,
      zeroBites: this.bites === 0,
      kills: this.kills,
      poolsDrained: this.poolsDrained,
      cratesCollected: this.cratesCollected,
      activeCrates: this.crates.length,
      activePools: this.pools.length,
      activeVectors: this.mosquitoes.length,
      poolFreezeActive: this.poolFreeze > 0,
      poolFreezeTimer: this.poolFreeze,
      slowActive: this.slowTimer > 0,
      slowTimer: this.slowTimer,
      surgeAlert: this.surgeAlertT > 0,
      surgeLabel: this.surgeLabel,
      surgeCount: this.surgeCount,
      hazardWeights: Object.assign({}, this.hazardWeights),
      hotspotDistricts: (this.hotspotIds || []).slice(),
      grade: over ? this.grade : null,
      victory: over ? this.victory : false,
      endReason: over ? this.endReason : null,
      clearBonus: over ? this.clearBonus : 0,
      unusedBedCapacity: over ? this.unusedBedCapacity : Math.max(0, Math.round(cap - load)),
      leaderboardMode: 'blitz',
      replay: {
        seedStr: this.seedStr,
        doctrine: this.doctrine,
        scenario: this.scenario,
      },
    };
  },
};

export { BlitzMode };
export default BlitzMode;
