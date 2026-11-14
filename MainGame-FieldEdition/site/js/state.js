/* Dengue Defense - Field Edition: Shared Rules, Doctrines & Mutable State.
   Deterministic RNG, campaign state (G) and wave state (W). No DOM access at
   import time. setG/setW mirror module-scoped state onto window.G / window.W
   (guarded) so Playwright E2E tests can inspect live state. */
import { MODEL_DATA } from './epi-data.js';
import { DISTRICT_DEFS, EpiRuntime, buildDistrict } from './epi-engine.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* =====================================================================
   RNG & SEEDING (extracted from legacy index.html)
   ===================================================================== */
export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function parseSeed(v) {
  let h = 2166136261;
  const s = String(v);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function randomSeedWord() {
  const A = ['MONSOON', 'SWATTER', 'LARVA', 'JOGJA', 'SURAKARTA', 'BOYOLALI', 'SLEMAN', 'KLATEN', 'GUNUNG', 'SUKOHARJO', 'WOLBACHIA', 'QUEEN', 'PUPA', 'AEDES', 'FOGGER'];
  const B = ['ALPHA', 'BRAVO', 'DELTA', 'ECHO', 'KILO', 'SIERRA', 'TANGO', 'ZULU', 'NOVA', 'ORION', 'VEGA', 'LYRA', 'COMET', 'STORM'];
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  return pick(A) + '-' + pick(B) + '-' + Math.floor(100 + Math.random() * 900);
}

/* =====================================================================
   GAME RULES (verbatim values from legacy index.html).
   Deterministic design layer, deliberately decoupled from MODEL_DATA.
   ===================================================================== */
export const GAME_RULES = Object.freeze({
  psnFactor: 0.75,
  drainFactor: 0.94,
  poolStep: 0.025,
  perfectArcadeFactor: 0.65,
  missedArcadeSpan: 0.55,
  careSlots: 240,
  clinicSlots: 150,
});

/* =====================================================================
   MONTHS (verbatim from legacy index.html; NOV..APR monsoon year)
   ===================================================================== */
export const MONTHS = Object.freeze([
  Object.freeze({ m: 'NOV', name: 'Early Onset',  rain: 0.80, intensity: 0.75, poolDelta: 1 }),
  Object.freeze({ m: 'DEC', name: 'Pre-Monsoon',  rain: 1.00, intensity: 0.90, poolDelta: 2 }),
  Object.freeze({ m: 'JAN', name: 'Peak Monsoon', rain: 1.30, intensity: 1.05, poolDelta: 3 }),
  Object.freeze({ m: 'FEB', name: 'Flood Surge',  rain: 1.25, intensity: 1.15, poolDelta: 1 }),
  Object.freeze({ m: 'MAR', name: 'Post-Peak',    rain: 0.95, intensity: 1.00, poolDelta: -1 }),
  Object.freeze({ m: 'APR', name: 'Dry Turn',     rain: 0.70, intensity: 0.90, poolDelta: -3 }),
]);

/* =====================================================================
   MODES (Command Hub entries; spec 04/05/06)
   ===================================================================== */
export const MODES = Object.freeze([
  Object.freeze({
    id: 'operations',
    name: Object.freeze({ en: 'Monsoon Operations', id: 'Operasi Musim Hujan' }),
    kind: 'hybrid_campaign',
    leaderboardKey: 'operations',
    defaultScenario: 'solo_basin',
    doctrineEligible: true,
    lengthMonths: Object.freeze([4, 6]),
    durationMinutes: Object.freeze([6, 10]),
    supportsPause: true,
    usesRealTimeCanvasLoop: true,
  }),
  Object.freeze({
    id: 'crisis_board',
    name: Object.freeze({ en: 'Crisis Board', id: 'Papan Krisis' }),
    kind: 'turn_based_strategy',
    leaderboardKey: 'crisis_board',
    defaultScenario: 'regional_board',
    doctrineEligible: true,
    weeks: 8,
    apPerTurn: 3,
    maxApCarryover: 1,
    durationMinutes: Object.freeze([4, 6]),
    supportsPause: true,
    usesRealTimeCanvasLoop: true,
  }),
  Object.freeze({
    id: 'blitz',
    name: Object.freeze({ en: 'Outbreak Blitz', id: 'Kilat Wabah' }),
    kind: 'real_time_arcade',
    leaderboardKey: 'blitz',
    defaultScenario: 'solo_blitz',
    doctrineEligible: true,
    durationSec: 150,
    comboDecaySec: 2.2,
    comboTiers: Object.freeze([1.0, 1.5, 2.0, 3.0, 4.0, 5.0]),
    durationMinutes: Object.freeze([2, 3]),
    supportsPause: true,
    usesRealTimeCanvasLoop: true,
  }),
]);

/* =====================================================================
   DOCTRINES (spec 01 section 4; exact modifiers)
   ===================================================================== */
export const DOCTRINES = Object.freeze([
  Object.freeze({
    id: 'surveillance_directorate',
    name: Object.freeze({ en: 'Surveillance Directorate', id: 'Direktorat Surveilans' }),
    identity: Object.freeze({
      en: 'Information superiority and targeted containment',
      id: 'Superioritas informasi dan penindakan terarah',
    }),
    summary: Object.freeze({
      en: '+15% Intel accuracy (shocks reveal one turn earlier); Surveillance Sweep costs 35% less (minimum 2 funds); one free District Risk Audit per campaign. Tradeoff: starting budget -2 funds.',
      id: '+15% akurasi Intel (kejutan terungkap satu giliran lebih awal); Patroli Surveilans 35% lebih murah (minimal 2 dana); satu Audit Risiko Wilayah gratis per kampanye. Konsekuensi: dana awal -2.',
    }),
    mods: Object.freeze({
      intelAccuracyBonus: 0.15,   // shocks reveal one turn earlier
      revealLead: 1,
      pingCostFactor: 0.65,       // 35% cheaper
      pingMinCost: 2,             // minimum 2 funds instead of 3
      pingBaseCost: 3,
      pingCostReduction: 1,
      freeRiskAudits: 1,          // +1 free District Risk Audit per campaign
      startFundsOffset: -2,       // starts at 16 instead of 18 in Mode 1
    }),
  }),
  Object.freeze({
    id: 'biocontrol_taskforce',
    name: Object.freeze({ en: 'Bio-Control Taskforce', id: 'Satgas Biokontrol' }),
    identity: Object.freeze({
      en: 'Ecological suppression through PSN and ovitraps',
      id: 'Supresi ekologis lewat PSN dan ovitrap',
    }),
    summary: Object.freeze({
      en: 'PSN and Ovitrap protocols cost 1 fund less (minimum 2); standing-water drain is twice as effective (drainFactor 0.90, poolStep 0.04). Tradeoff: Thermal Fogging costs +1 fund and trims 5% ecology bonus if overused.',
      id: 'Protokol PSN dan Ovitrap 1 dana lebih murah (minimal 2); pengurasan genangan dua kali lebih efektif (drainFactor 0.90, poolStep 0.04). Konsekuensi: Fogging Terfokus +1 dana dan memangkas 5% bonus ekologi bila berlebihan.',
    }),
    mods: Object.freeze({
      psnTrapCostReduction: 1,    // PSN & Ovitrap cost -1 fund
      minProtocolCost: 2,         // floor of 2 funds
      drainFactor: 0.90,          // per swiped puddle (was 0.94)
      poolStep: 0.04,             // instead of +0.025
      fogCostOffset: 1,           // Thermal Fogging +1 fund
      fogEcologyPenalty: 0.05,    // -5% ecology bonus if overused
    }),
  }),
  Object.freeze({
    id: 'rapid_response_corps',
    name: Object.freeze({ en: 'Rapid Response Corps', id: 'Korps Reaksi Cepat' }),
    identity: Object.freeze({
      en: 'Surge medical capacity and frontline interception',
      id: 'Kapasitas lonjakan medis dan intersepsi garda depan',
    }),
    summary: Object.freeze({
      en: 'Field Clinics provide +50 surge capacity (200 beds per clinic) and base ICU capacity starts at 280 (+40 over 240); Swat radius +18%; Containment Spray charges 20% faster. Tradeoff: passive PSN softened to psnFactor 0.80.',
      id: 'Posko Triage +50 kapasitas lonjakan (200 bed per klinik) dan ICU dasar mulai dari 280 (+40 dari 240); radius swat +18%; Pengisian Semprot Kontainmen 20% lebih cepat. Konsekuensi: PSN pasif melemah ke psnFactor 0.80.',
    }),
    mods: Object.freeze({
      clinicSlots: 200,           // per clinic, instead of 150
      clinicSlotsBonus: 50,
      baseIcuCap: 280,            // +40 over 240
      icuCapBonus: 40,
      swatRadiusFactor: 1.18,     // +18% swat radius
      sprayChargeFactor: 1.20,    // spray charges 20% faster
      psnFactor: 0.80,            // tradeoff: passive PSN softened
    }),
  }),
]);

/* =====================================================================
   SCENARIOS (spec 04 section 1; month ranges, fund offsets, climateProfile)
   fundOffset is relative to the canonical 18-fund Mode 1 start.
   ===================================================================== */
export const SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'solo_basin',
    name: Object.freeze({ en: 'Standard Monsoon', id: 'Musim Hujan Standar' }),
    months: Object.freeze(['NOV', 'DEC', 'JAN', 'FEB', 'MAR', 'APR']),
    monthRange: Object.freeze([0, 5]),
    lengthMonths: 6,
    startFunds: 18,
    fundOffset: 0,
    climateProfile: 'baseline',
    hotspots: Object.freeze([]),
    desc: Object.freeze({
      en: 'Canonical six-regency campaign with a balanced rainfall curve. Recommended first run and default test scenario.',
      id: 'Kampanye kanonik enam kabupaten dengan kurva hujan seimbang. Direkomendasikan untuk permainan pertama.',
    }),
  }),
  Object.freeze({
    id: 'merapi_ashfall',
    name: Object.freeze({ en: 'Merapi Perimeter Surge', id: 'Siaga Lereng Merapi' }),
    months: Object.freeze(['DEC', 'JAN', 'FEB', 'MAR']),
    monthRange: Object.freeze([1, 4]),
    lengthMonths: 4,
    startFunds: 20,
    fundOffset: 2,
    climateProfile: 'monsoon_surge',
    hotspots: Object.freeze(['boyolali', 'sleman', 'klaten']),
    climatePressure: 0.25,        // +25% climate pressure on highland hotspots
    reportingLagBoost: true,      // ashfall increases reporting-lag probability
    desc: Object.freeze({
      en: 'Highland spillover: Boyolali, Sleman and Klaten take +25% climate pressure; ashfall raises reporting-lag probability. Starts with 20 funds.',
      id: 'Limpahan dataran tinggi: Boyolali, Sleman dan Klaten menanggung +25% tekanan iklim; abu vulkanik meningkatkan probabilitas lag laporan. Dana awal 20.',
    }),
  }),
  Object.freeze({
    id: 'bengawan_flood',
    name: Object.freeze({ en: 'Bengawan Floodplain', id: 'Banjir Bengawan Solo' }),
    months: Object.freeze(['DEC', 'JAN', 'FEB', 'MAR', 'APR']),
    monthRange: Object.freeze([1, 5]),
    lengthMonths: 5,
    startFunds: 18,
    fundOffset: 0,
    climateProfile: 'monsoon_surge',
    hotspots: Object.freeze(['surakarta', 'sukoharjo', 'klaten']),
    poolSpawnMult: 2,             // 2x standing-water pools during waves; drain pays double
    desc: Object.freeze({
      en: 'Heavy riparian breeding along Surakarta, Sukoharjo and Klaten; standing-water pools spawn twice as often and draining pays double.',
      id: 'Perindukan riparian berat di Surakarta, Sukoharjo dan Klaten; genangan air muncul dua kali lebih sering dan pengurasan bernilai dua kali.',
    }),
  }),
  Object.freeze({
    id: 'commuter_corridor',
    name: Object.freeze({ en: 'Solo-Yogya Rail Corridor', id: 'Koridor Komuter Solo-Yogya' }),
    months: Object.freeze(['JAN', 'FEB', 'MAR', 'APR']),
    monthRange: Object.freeze([2, 5]),
    lengthMonths: 4,
    startFunds: 18,
    fundOffset: 0,
    climateProfile: 'urban_commuter',
    hotspots: Object.freeze(['sleman', 'klaten', 'surakarta']),
    mobilityMult: 2,              // Sleman-Klaten-Surakarta spillover doubled
    desc: Object.freeze({
      en: 'Cross-district commuter spillover doubles along Sleman - Klaten - Surakarta; rewards surveillance sweeps and fast containment.',
      id: 'Limpahan komuter antar-kabupaten berlipat dua di Sleman - Klaten - Surakarta; menghargai patroli surveilans dan penindakan cepat.',
    }),
  }),
]);

/* =====================================================================
   PROTOCOLS (spec 03 lexicon; costs per specs 03/04/05)
   costFunds = Mode 1 fund price; costAp = Mode 2 action-point price.
   ===================================================================== */
export const PROTOCOLS = Object.freeze([
  Object.freeze({
    id: 'psn',
    name: Object.freeze({ en: 'Source Cleanup (PSN)', id: 'PSN 3M Plus' }),
    tooltip: Object.freeze({
      en: 'Clears larval habitats around homes; cuts monthly baseline pressure.',
      id: 'Membersihkan habitat jentik di sekitar rumah; memangkas tekanan baseline bulanan.',
    }),
    costFunds: 3,
    costAp: 1,
    minFunds: 2,
    costReductionDoctrine: 'biocontrol_taskforce',   // -1 fund under Bio-Control (min 2)
    scope: 'district',
    duration: 'month',
  }),
  Object.freeze({
    id: 'traps',
    name: Object.freeze({ en: 'Lethal Ovitraps', id: 'Ovitrap Mematikan' }),
    tooltip: Object.freeze({
      en: 'Eliminates egg-laying females entering perimeter wards.',
      id: 'Membasmi nyamuk betina bertelur yang memasuki area posko.',
    }),
    costFunds: 3,
    costAp: 1,
    minFunds: 2,
    costReductionDoctrine: 'biocontrol_taskforce',   // -1 fund under Bio-Control (min 2)
    scope: 'district',
    duration: 'wave',
  }),
  Object.freeze({
    id: 'fog',
    name: Object.freeze({ en: 'Thermal Fogging', id: 'Fogging Terfokus' }),
    tooltip: Object.freeze({
      en: 'Rapid knockdown of adult swarms; high cost, slight ecology penalty if spammed.',
      id: 'Penumbangan cepat kawanan nyamuk dewasa; biaya tinggi, sedikit penalti ekologi bila berlebihan.',
    }),
    costFunds: 4,
    costAp: 2,                                       // Sector Fogging: 2 AP (spec 05)
    costOffsetDoctrine: 'biocontrol_taskforce',      // +1 fund under Bio-Control tradeoff
    costOffset: 1,
    ecologyPenalty: 0.05,
    scope: 'district',
    duration: 'wave',
  }),
  Object.freeze({
    id: 'clinic',
    name: Object.freeze({ en: 'Field Triage Ward', id: 'Posko Triage Lapangan' }),
    tooltip: Object.freeze({
      en: 'Expands local bed surge capacity and slows systemic fever panic.',
      id: 'Memperluas kapasitas lonjakan bed dan meredam kepanikan demam sistemik.',
    }),
    costFunds: 5,
    costAp: 1,                                       // Emergency Ward Surge: 1 AP (spec 05)
    slots: GAME_RULES.clinicSlots,                   // 150 regional beds (200 under Rapid Response)
    rapidResponseSlots: 200,
    scope: 'regional',
    duration: 'month',
  }),
  Object.freeze({
    id: 'ping',
    name: Object.freeze({ en: 'Surveillance Sweep', id: 'Patroli Surveilans' }),
    tooltip: Object.freeze({
      en: 'Reveals concealed weather and transit anomalies in the selected regency.',
      id: 'Mengungkap anomali cuaca dan transit tersembunyi di kabupaten terpilih.',
    }),
    costFunds: 3,                                    // 3 funds base (spec 04)
    costAp: 1,
    minFunds: 2,
    discountDoctrine: 'surveillance_directorate',     // 35% cheaper, min 2 funds (spec 01/04)
    scope: 'district',
    duration: 'instant',
  }),
  Object.freeze({
    id: 'quarantine',
    name: Object.freeze({ en: 'Cordon Border', id: 'Sekat Perbatasan' }),
    tooltip: Object.freeze({
      en: 'Cuts inter-regency commuter transmission along one shared border for 2 turns.',
      id: 'Memutus penularan komuter antar-kabupaten pada satu perbatasan bersama selama 2 giliran.',
    }),
    costFunds: 2,
    costAp: 1,                                       // Border Cordon: 1 AP (spec 05)
    spilloverBlock: 0.85,                            // blocks 85% of commuter spillover
    durationTurns: 2,                                // 2 weeks
    maxActive: 2,
    maxActiveDoctrine: 'rapid_response_corps',       // 3 simultaneous cordons
    maxActiveDoctrineValue: 3,
    mode: 'crisis_board',
    scope: 'border',
    duration: '2 turns',
  }),
]);

/* =====================================================================
   MUTATORS (the 6 legacy mutators; icons removed, economy text updated to
   the fund-based rules. scoreMult multiplies all listed mults)
   ===================================================================== */
export const MUTATORS = Object.freeze([
  Object.freeze({ id: 'swarm',      name: 'Swarm Season',  mult: 1.25, desc: '40% more mosquitoes every wave. The skies never quiet down.' }),
  Object.freeze({ id: 'hardy',      name: 'Hardy Strain',  mult: 1.2,  desc: 'Wild mosquitoes take an extra swat to down. Aim carefully.' }),
  Object.freeze({ id: 'budget',     name: 'Austerity',     mult: 1.3,  desc: 'Starting operations funds cut by 40% and monthly allocation down 30%.' }),
  Object.freeze({ id: 'monsoon',    name: 'Monsoon Surge', mult: 1.35, desc: 'Larva pools refill faster and pressure rises every month you survive.' }),
  Object.freeze({ id: 'royal',      name: 'Royal Hunt',    mult: 1.2,  desc: 'A queen arrives from month 1, and she is worth triple points.' }),
  Object.freeze({ id: 'feverstart', name: 'Fever Pitch',   mult: 1.25, desc: 'Overdrive charges 50% faster all campaign.' }),
]);

/* =====================================================================
   PERKS (12 legacy field doctrines; disclaimers stripped, apply() takes an
   explicit state object instead of touching module globals)
   ===================================================================== */
export const PERKS = Object.freeze([
  Object.freeze({ id: 'volunteers', name: 'Jumantik Volunteers', desc: '+1 field crew every month', stack: true,
    apply(state) { state.unitsMax = (state.unitsMax || 0) + 1; } }),
  Object.freeze({ id: 'racket',     name: 'Volt Sweeper',        desc: 'Wider sweep arc with an electric discharge trail that eliminates nearby vectors' }),
  Object.freeze({ id: 'traps2',     name: 'Ovitrap 2.0',         desc: 'Traps pull from 50% farther and recharge faster' }),
  Object.freeze({ id: 'fog2',       name: 'Turbo Foggers',       desc: 'Fog blasts every 2s instead of 3s' }),
  Object.freeze({ id: 'spray',      name: 'Aerosol Stockpile',   desc: '+1 Emergency Spray Bomb per wave', stack: true }),
  Object.freeze({ id: 'grants',     name: 'Emergency Village Grant', desc: 'Boosts monthly regional Operations Funds allocation', stack: true }),
  Object.freeze({ id: 'rapid',      name: 'Rapid Triage',        desc: '+60 shared care slots for every remaining month',
    apply(state) { state.capacity = (state.capacity || 0) + 60; } }),
  Object.freeze({ id: 'hospital',   name: 'Field Care Hub',      desc: '+100 shared care slots for every remaining month', stack: true,
    apply(state) { state.capacity = (state.capacity || 0) + 100; } }),
  Object.freeze({ id: 'media',      name: 'Viral Campaign',      desc: '+12 public trust right now', stack: true,
    apply(state) { state.trust = clamp((state.trust || 0) + 12, 0, 100); } }),
  Object.freeze({ id: 'wolbachia',  name: 'Wolbachia Release',   desc: 'Expands beneficial Wolbachia mosquitoes; each intercepts up to 2 wild vectors' }),
  Object.freeze({ id: 'lotion',     name: 'Repellent Lotion',    desc: 'Mosquitoes take 25% longer before biting' }),
  Object.freeze({ id: 'combo',      name: 'Combo Master',        desc: 'Overdrive Fever charges 30% faster and lasts 6s' }),
]);

/* =====================================================================
   ACHIEVEMENTS (10 legacy badges + 3 mode-mastery badges; zero emojis)
   ===================================================================== */
export const ACHIEVEMENTS = Object.freeze([
  Object.freeze({ id: 'first_wave',     title: 'First Line',            desc: 'Survive Month 1 (Early Onset)' }),
  Object.freeze({ id: 'fever',          title: 'Overdrive Frenzy',      desc: 'Trigger 2X Fever Mode in any wave' }),
  Object.freeze({ id: 'combo_15',       title: 'Combo Legend',          desc: 'Reach a 15x Swat Combo streak' }),
  Object.freeze({ id: 'perfect_wave',   title: 'Flawless Defense',      desc: 'Clear any wave with 0 bites' }),
  Object.freeze({ id: 'queen_slayer',   title: 'Regicide',              desc: 'Defeat a Queen Aedes mosquito' }),
  Object.freeze({ id: 'drain_master',   title: 'Jumantik Scout',        desc: 'Drain 5 bubbling breeding pools' }),
  Object.freeze({ id: 'blood_healer',   title: 'Extra Prevention',      desc: 'Swat an engorged mosquito for a prevention bonus' }),
  Object.freeze({ id: 'wolbachia_ally', title: 'Bio-Alliance',          desc: 'Let a friendly mosquito intercept a wild bug' }),
  Object.freeze({ id: 'rich_commander', title: 'Emergency Reserve',     desc: 'Accumulate a major operations fund reserve' }),
  Object.freeze({ id: 's_rank',         title: 'EPI-KD Director',       desc: 'Complete campaign with S-Rank (>14,000 pts)' }),
  // Mode-mastery badges (new)
  Object.freeze({ id: 'operations_master',   title: 'Monsoon Director',       desc: 'Win a Monsoon Operations campaign in any scenario' }),
  Object.freeze({ id: 'crisis_board_master', title: 'Boardroom Epidemiologist', desc: 'Resolve Week 8 with every district below collapse threshold' }),
  Object.freeze({ id: 'blitz_master',        title: 'Hotline Legend',         desc: 'Finish Outbreak Blitz with an S grade' }),
]);

/* =====================================================================
   MUTABLE STATE: module-scoped G (campaign) and W (wave), mirrored onto
   window.G / window.W on every transition for E2E inspection.
   ===================================================================== */
let G = null;
let W = null;
let campaignSerial = 0;

export function getG() { return G; }
export function getW() { return W; }

export function setG(nextG) {
  G = nextG || null;
  if (typeof window !== 'undefined') window.G = G;
  return G;
}

export function setW(nextW) {
  W = nextW || null;
  if (typeof window !== 'undefined') window.W = W;
  return W;
}

export function scoreMult() {
  const muts = (G && Array.isArray(G.mutators)) ? G.mutators : [];
  return muts.reduce((m, id) => m * ((MUTATORS.find(x => x.id === id) || {}).mult || 1), 1);
}

export function hasMut(id) {
  return !!(G && Array.isArray(G.mutators) && G.mutators.includes(id));
}

/* Fresh campaign state. Legacy parity: seeds deterministic RNGs, builds the
   six district instances (polygons, trap points, pools) and runs the EpiKD
   baseline forecast so every district carries cases/outlook/epi. District
   inference failures never block state creation.
   options (all optional): { mode, doctrine, scenario }
     mode     - 'operations' (default) | 'crisis_board' | 'blitz'
     doctrine - doctrine id (see DOCTRINES)
     scenario - scenario id (Mode 1); defaults to the mode's defaultScenario */
export function freshState(seedStr, mutators, options = {}) {
  const opts = (options && typeof options === 'object') ? options : {};
  const modeDef = MODES.find(m => m.id === opts.mode) || MODES[0];
  const mode = modeDef.id;
  const scenario = opts.scenario || modeDef.defaultScenario || null;
  const doctrine = DOCTRINES.some(d => d.id === opts.doctrine) ? opts.doctrine : null;
  const scen = SCENARIOS.find(s => s.id === scenario) || null;
  const doctrineDef = DOCTRINES.find(d => d.id === doctrine) || null;

  const state = {
    seedStr: seedStr || randomSeedWord(),
    mutators: Array.isArray(mutators) ? mutators.slice() : [],
    mode,
    doctrine,
    scenario,
    serial: 0,
    turn: 0,
    budget: scen ? scen.startFunds : 18,
    unitsMax: 4,
    turnUnits: 0,
    capacity: GAME_RULES.careSlots,
    hospitalLoad: 0,
    hospitalCap: GAME_RULES.careSlots,
    clinicSlots: GAME_RULES.clinicSlots,
    tempCapacity: 0,
    trust: 70,
    score: 0,
    perks: {},
    selected: 'klaten',
    phase: 'title',
    spawnMod: 1,
    prevention: 0,
    stanceLabel: '',
    modelHistory: {},
    scenarioRng: null,
    reports: [],
    turnShocks: [],
    turnIntel: [],
    turnShockTimer: null,
    intelCount: 0,
    totals: { swats: 0, bites: 0, auto: 0, bestCombo: 0, queens: 0, drained: 0, feverCount: 0, cases: 0, baseline: 0 },
    firstPlan: true,
    districts: [],
  };

  // Doctrine starting modifiers (spec 01 section 4)
  if (doctrineDef) {
    const m = doctrineDef.mods;
    if (m.startFundsOffset) state.budget += m.startFundsOffset;
    if (m.clinicSlots) state.clinicSlots = m.clinicSlots;
    if (m.baseIcuCap) state.hospitalCap = m.baseIcuCap;
  }
  // Austerity mutator: start with 60% of the mode budget (legacy: 180 of 300 Rp M)
  if (state.mutators.includes('budget')) state.budget = Math.round(state.budget * 0.6);

  state.scenarioRng = mulberry32(parseSeed(state.seedStr));
  const mapRng = mulberry32(parseSeed(state.seedStr + '/map'));
  campaignSerial += 1;
  state.serial = campaignSerial;
  state.districts = DISTRICT_DEFS.map(def => buildDistrict(def, mapRng));

  try {
    const model = EpiRuntime.create(MODEL_DATA);
    const forecasts = model.predictAll(0);
    for (const d of state.districts) {
      const source = MODEL_DATA.districts[d.id];
      d.cases = Math.max(0, Math.round(EpiRuntime.sample(source.cases[23] ?? 0, 6, state.scenarioRng)));
      d.startCases = d.cases;
      d.pop = (source.population[23] / 1e6).toFixed(2) + 'M';
      d.nb = Object.keys(source.weights).filter(id => source.weights[id] > 0);
      d.outlook = forecasts[d.id];
      d.epi = d.outlook[0];
      const lastRain = source.rain && Number.isFinite(source.rain[23])
        ? source.rain[23]
        : ((source.rain || []).filter(Number.isFinite).pop() || 0);
      d.pools = Math.round(clamp(5 + lastRain / 60, 4, 14));
      d.referencePools = d.pools;
      d.trueShockMult = 1.0;
      d.trueDelayedCases = 0;
      d.revealedShockMult = 1.0;
      d.revealedDelayedCases = 0;
      d.intelEvents = [];
    }
  } catch (err) {
    // Inference must never block state creation (e.g. offline test harness).
    for (const d of state.districts) {
      d.cases = 0;
      d.startCases = 0;
      d.pop = '1.00M';
      d.nb = Array.isArray(d.nb) ? d.nb : [];
      d.outlook = null;
      d.epi = null;
      d.pools = 6;
      d.referencePools = 6;
      d.trueShockMult = 1.0;
      d.trueDelayedCases = 0;
      d.revealedShockMult = 1.0;
      d.revealedDelayedCases = 0;
      d.intelEvents = [];
    }
  }

  setG(state);
  return state;
}
