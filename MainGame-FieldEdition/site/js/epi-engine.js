/* Dengue Defense - Field Edition: Epidemiological Engine & Regional Geography.
   EpiRuntime is a verbatim extraction of the offline EpiKD KDA inference port
   (legacy index.html lines 646-860). MODEL_DATA (weights, seed 17, params
   52220) lives in ./epi-data.js and is never mutated here.
   No DOM access at import time: Path2D/canvas usage is feature-detected and
   ray-casting is used for point-in-polygon tests. */
import { MODEL_DATA } from './epi-data.js';

/* =====================================================================
   EPIRUNTIME (verbatim from legacy index.html lines 646-860)
   ===================================================================== */
const EpiRuntime = (() => {
  const ids = ['boyolali', 'surakarta', 'sleman', 'klaten', 'sukoharjo', 'gunungkidul'];
  const sigmoid = x => x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
  const softplus = x => Math.max(0, x) + Math.log1p(Math.exp(-Math.abs(x)));
  const silu = x => x * sigmoid(x);

  function create(data) {
    const bytes = Uint8Array.from(atob(data.weights.base64), c => c.charCodeAt(0));
    const floats = new Float32Array(bytes.buffer);
    const weights = {};
    let offset = 0;
    for (const name of data.weights.names) {
      const shape = data.weights.shapes[name];
      const length = shape.reduce((a, b) => a * b, 1);
      weights[name] = { values: floats.subarray(offset, offset + length), shape };
      offset += length;
    }
    if (offset !== floats.length) throw new Error('EpiKD weight buffer has an invalid length.');
    const val = name => weights[name].values;
    function linear(x, name) {
      const w = weights[name + '.weight'], b = val(name + '.bias');
      const [rows, cols] = w.shape, out = new Float64Array(rows);
      for (let r = 0; r < rows; r++) {
        let sum = b[r];
        const start = r * cols;
        for (let c = 0; c < cols; c++) sum += w.values[start + c] * x[c];
        out[r] = sum;
      }
      return out;
    }
    function norm(x, name) {
      const w = val(name + '.weight');
      let sum = 0;
      for (const v of x) sum += v * v;
      const scale = 1 / Math.sqrt(sum / x.length + 1e-5);
      return Float64Array.from(x, (v, i) => v * scale * w[i]);
    }
    function conv(sequence, proj, convName) {
      const projected = sequence.map(x => linear(x, proj));
      const w = val(convName + '.weight'), b = val(convName + '.bias');
      return projected.map((row, t) => Float64Array.from(row, (_, c) => {
        let n = b[c];
        for (let j = 0; j < 3; j++) if (t + j >= 2) n += projected[t + j - 2][c] * w[c * 3 + j];
        return silu(n);
      }));
    }
    function block(sequence, index) {
      const prefix = 'blocks.' + index + '.';
      const h = sequence.map(x => norm(x, prefix + 'norm1'));
      const q = conv(h, prefix + 'q_proj', prefix + 'q_conv');
      const k = conv(h, prefix + 'k_proj', prefix + 'k_conv');
      const v = conv(h, prefix + 'v_proj', prefix + 'v_conv');
      const state = new Float64Array(2 * 32 * 32);
      const headNorm = val(prefix + 'head_norm_weight');
      return sequence.map((row, t) => {
        const alpha = linear(linear(h[t], prefix + 'alpha_proj.0'), prefix + 'alpha_proj.1');
        const beta = linear(h[t], prefix + 'beta_proj');
        const gate = linear(linear(h[t], prefix + 'gate_proj.0'), prefix + 'gate_proj.1');
        const o = new Float64Array(64);
        for (let head = 0; head < 2; head++) {
          const base = head * 32, stateBase = head * 1024;
          let qNorm = 0, kNorm = 0;
          for (let j = 0; j < 32; j++) { qNorm += q[t][base + j] ** 2; kNorm += k[t][base + j] ** 2; }
          qNorm = Math.max(1e-6, Math.sqrt(qNorm)); kNorm = Math.max(1e-6, Math.sqrt(kNorm));
          for (let j = 0; j < 32; j++) {
            q[t][base + j] /= qNorm; k[t][base + j] /= kNorm;
            alpha[base + j] = Math.exp(Math.max(-10, Math.min(-1e-4, -softplus(alpha[base + j]))));
          }
          const update = sigmoid(beta[head]);
          for (let i = 0; i < 32; i++) {
            const start = stateBase + i * 32;
            let predicted = 0;
            for (let j = 0; j < 32; j++) {
              state[start + j] *= alpha[base + j];
              predicted += state[start + j] * k[t][base + j];
            }
            const error = v[t][base + i] - predicted;
            let output = 0;
            for (let j = 0; j < 32; j++) {
              state[start + j] += update * error * k[t][base + j];
              output += state[start + j] * q[t][base + j];
            }
            o[base + i] = output;
          }
          let square = 0;
          for (let i = 0; i < 32; i++) square += o[base + i] ** 2;
          const n = 1 / Math.sqrt(square / 32 + 1e-5);
          for (let i = 0; i < 32; i++) o[base + i] *= n * headNorm[base + i] * sigmoid(gate[base + i]);
        }
        const projected = linear(o, prefix + 'out_proj');
        const residual = Float64Array.from(row, (x, i) => x + projected[i]);
        const ff1 = linear(norm(residual, prefix + 'norm2'), prefix + 'ffn.0');
        const ff2 = linear(Float64Array.from(ff1, silu), prefix + 'ffn.3');
        return Float64Array.from(residual, (x, i) => x + ff2[i]);
      });
    }
    function features(turn, district, histories = {}) {
      if (!Number.isInteger(turn) || turn < 0 || turn >= data.snapshots.length) throw new Error('Invalid EpiKD issue month.');
      const snapshot = data.snapshots[turn], index = ids.indexOf(district);
      if (index < 0) throw new Error('Unknown EpiKD district.');
      const d = data.districts[district], raw = snapshot.raw[index].map(row => row.slice());
      const own = histories[district] || {};
      let lastObserved = -1;
      for (let t = 0; t < 24; t++) {
        const ordinal = snapshot.issue - 23 + t;
        const dataIndex = ordinal - data.history0;
        if (Object.hasOwn(own, ordinal)) {
          const c = own[ordinal];
          if (!Number.isInteger(c) || c < 0) throw new Error('Simulated case counts must be nonnegative integers.');
          raw[t][0] = Math.log1p(c); raw[t][1] = Math.log1p(c / d.scale); raw[t][2] = 1;
        }
        if (raw[t][2] > 0) lastObserved = t;
        raw[t][3] = lastObserved < 0 ? 1 : Math.min(24, t - lastObserved) / 24;
        const changedNeighbor = ids.some(id => d.weights[id] > 0 && Object.hasOwn(histories[id] || {}, ordinal));
        if (changedNeighbor) {
          let numerator = d.externalNumerator[dataIndex], coverage = d.externalCoverage[dataIndex];
          for (const id of ids) {
            const nd = data.districts[id], weight = d.weights[id], pop = nd.population[dataIndex];
            const nh = histories[id] || {};
            const cases = Object.hasOwn(nh, ordinal) ? nh[ordinal] : nd.cases[dataIndex];
            if (weight > 0 && cases !== null && pop !== null && pop > 0) {
              numerator += weight * 1e5 * cases / pop; coverage += weight;
            }
          }
          raw[t][16] = coverage >= .5 ? Math.log1p(Math.max(0, numerator / coverage)) : null;
          raw[t][17] = coverage; raw[t][18] = coverage >= .5 ? 1 : 0;
        }
      }
      return raw.map(row => row.map((value, j) => {
        const x = Number.isFinite(value) ? value : data.prep.median[j];
        return data.prep.stdCols.includes(j) ? (x - data.prep.median[j]) / data.prep.std[j] : x;
      }));
    }
    function predict(turn, district, histories = {}) {
      const index = ids.indexOf(district), d = data.districts[district];
      const snapshot = data.snapshots[turn], x = features(turn, district, histories);
      const rEmb = val('region_emb.weight').subarray(d.regionIndex * 8, d.regionIndex * 8 + 8);
      const pEmb = val('province_emb.weight').subarray(d.provinceIndex * 4, d.provinceIndex * 4 + 4);
      const staticVector = linear([...rEmb, ...pEmb, ...snapshot.static[index]], 'static_proj');
      let sequence = x.map(row => {
        const projected = linear(row, 'input_proj');
        return Float64Array.from(projected, (v, i) => v + staticVector[i]);
      });
      for (let i = 0; i < data.meta.layers; i++) sequence = block(sequence, i);
      const rep = norm(sequence[sequence.length - 1], 'final_norm');
      return [0, 1, 2].map(h => {
        const z = linear([...rep, ...snapshot.future[h]], `heads.${h}.0`);
        const ab = linear(Float64Array.from(z, silu), `heads.${h}.3`);
        const mu = 1e-6 + d.scale * softplus(ab[0]), kappa = 1e-4 + softplus(ab[1]);
        const threshold = d.thresholds[(snapshot.issue + h + 1) % 12];
        return { mu, kappa, threshold, eventProb: nbTail(threshold, mu, kappa),
          low80: nbQuantile(.1, mu, kappa), high80: nbQuantile(.9, mu, kappa),
          issue: snapshot.issue, target: snapshot.issue + h + 1, horizon: h + 1 };
      });
    }
    return { data, features, predict, predictAll: (turn, histories = {}) => Object.fromEntries(ids.map(id => [id, predict(turn, id, histories)])) };
  }

  // NB2 distribution: scipy.stats.nbinom(n=kappa, p=kappa/(kappa+mu)).
  function logGamma(z) {
    const c = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
      12.507343278686905, -.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
    if (z < .5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
    z -= 1;
    let x = .9999999999998099;
    for (let i = 0; i < c.length; i++) x += c[i] / (z + i + 1);
    const t = z + 7.5;
    return .9189385332046727 + (z + .5) * Math.log(t) - t + Math.log(x);
  }
  function betaFraction(a, b, x) {
    const tiny = 1e-30;
    let c = 1, d = 1 - (a + b) * x / (a + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
      d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const delta = d * c; h *= delta;
      if (Math.abs(delta - 1) < 3e-13) return h;
    }
    throw new Error('NB beta fraction does not converge.');
  }
  function betaInc(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
    return x < (a + 1) / (a + b + 2) ? bt * betaFraction(a, b, x) / a : 1 - bt * betaFraction(b, a, 1 - x) / b;
  }
  function nbTail(threshold, mu, kappa) {
    if (threshold <= 0) return 1;
    return Math.max(0, Math.min(1, betaInc(mu / (kappa + mu), threshold, kappa)));
  }
  function nbQuantile(prob, mu, kappa) {
    if (!(mu > 0) || !(kappa > 0)) throw new Error('NB parameters must be positive.');
    if (prob <= 0) return 0;
    if (prob >= 1) return Infinity;
    const p = kappa / (kappa + mu), cdf = n => betaInc(p, kappa, n + 1);
    let low = 0, high = Math.max(1, Math.ceil(mu + 8 * Math.sqrt(mu + mu * mu / kappa)));
    while (cdf(high) < prob) high *= 2;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (cdf(mid) >= prob) high = mid; else low = mid + 1; }
    return low;
  }
  return { create, nbTail, nbQuantile, sample: (mu, kappa, rng) => nbQuantile(rng(), mu, kappa) };
})();

/* =====================================================================
   GEOGRAPHY: RISK TIERS (verbatim from legacy index.html)
   ===================================================================== */
const RISK = [
  { name: 'SAFE',     fill: [38, 167, 86],   a: 0.22, color: '#A5F690' },
  { name: 'ELEVATED', fill: [255, 238, 88],  a: 0.26, color: '#FBCE03' },
  { name: 'HIGH',     fill: [227, 25, 59],   a: 0.32, color: '#FFB2B8' },
  { name: 'CRITICAL', fill: [121, 82, 255],  a: 0.40, color: '#B3B0FE' },
];

/* Windward concern: RIVER paths kept as data strings so this module stays
   importable in non-DOM runtimes (node). When Path2D exists (browsers),
   RIVERS exports native Path2D instances; otherwise plain { d } stubs. */
const RIVER_PATHS = Object.freeze([
  'M 430,210 C 445,180 465,165 510,130 C 555,95 610,75 680,55',
  'M 218,125 C 210,195 190,260 155,345',
]);
const RIVERS = typeof Path2D !== 'undefined'
  ? RIVER_PATHS.map(d => new Path2D(d))
  : RIVER_PATHS.map(d => ({ d }));

/* District definitions (verbatim from legacy index.html): SVG path data,
   centroids (c), population, baseline cases/pools and adjacency (nb). */
const DISTRICT_DEFS = [
  { id: 'boyolali', name: 'BOYOLALI', pop: '1.07M', c: [318, 108], cases: 90, pools: 6, nb: ['sleman', 'surakarta', 'klaten'],
    d: 'M 220,55 L 385,40 L 445,95 L 430,140 L 385,155 L 350,195 L 250,185 L 220,125 Z' },
  { id: 'surakarta', name: 'SURAKARTA', pop: '0.58M', c: [428, 180], cases: 230, pools: 13, nb: ['boyolali', 'klaten', 'sukoharjo'],
    d: 'M 385,155 L 430,140 L 485,155 L 480,205 L 430,210 L 350,195 Z' },
  { id: 'sleman', name: 'SLEMAN', pop: '1.14M', c: [172, 192], cases: 130, pools: 8, nb: ['boyolali', 'klaten', 'gunungkidul'],
    d: 'M 95,155 L 220,55 L 220,125 L 250,185 L 230,275 L 115,265 Z' },
  { id: 'klaten', name: 'KLATEN', pop: '1.27M', c: [330, 252], cases: 190, pools: 10, nb: ['boyolali', 'surakarta', 'sleman', 'sukoharjo', 'gunungkidul'],
    d: 'M 250,185 L 350,195 L 430,210 L 405,295 L 320,315 L 230,275 Z' },
  { id: 'sukoharjo', name: 'SUKOHARJO', pop: '0.91M', c: [508, 255], cases: 160, pools: 9, nb: ['surakarta', 'klaten', 'gunungkidul'],
    d: 'M 430,210 L 480,205 L 485,155 L 575,180 L 560,310 L 445,335 L 405,295 Z' },
  { id: 'gunungkidul', name: 'GUNUNGKIDUL', pop: '0.77M', c: [338, 382], cases: 60, pools: 4, nb: ['sleman', 'klaten', 'sukoharjo'],
    d: 'M 160,355 L 230,275 L 320,315 L 405,295 L 445,335 L 515,425 L 340,445 L 195,430 Z' },
];

/* =====================================================================
   CLIMATE PROFILES (feature-space perturbation, MODEL_DATA untouched)
   Optional 'climateProfile' modifier accepted by the forecast / spawn
   computation below. Perturbs rainfall and mobility pressure as bounded
   multiplicative deltas applied AFTER EpiRuntime inference. The MODEL_DATA
   weights are never cloned or mutated.
     baseline        - canonical monsoon curve, no perturbation
     el_nino_drought - suppressed rainfall habitat (-28% rain, soft dry bias)
     monsoon_surge   - amplified rainfall + minor mobility bump
     urban_commuter  - neutral rain, strongly amplified cross-district mobility
   ===================================================================== */
const CLIMATE_PROFILES = Object.freeze({
  baseline:        Object.freeze({ rainfall: 1.00, mobility: 1.00, mu: 1.00, pressure: 1.00 }),
  el_nino_drought: Object.freeze({ rainfall: 0.72, mobility: 0.95, mu: 0.88, pressure: 0.85 }),
  monsoon_surge:   Object.freeze({ rainfall: 1.35, mobility: 1.08, mu: 1.18, pressure: 1.22 }),
  urban_commuter:  Object.freeze({ rainfall: 1.00, mobility: 1.45, mu: 1.12, pressure: 1.15 }),
});
function climateProfileOf(profile) {
  return CLIMATE_PROFILES[profile] || CLIMATE_PROFILES.baseline;
}

/* Mirror of GAME_RULES constants needed for engine math. state.js imports
   this module, so the engine cannot import GAME_RULES from state.js
   (circular import). Keep these values in sync with state.js GAME_RULES. */
const ENGINE_RULES = Object.freeze({ psnFactor: 0.75, drainFactor: 0.94, poolStep: 0.025 });

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* =====================================================================
   POLYGON MATH (pure JS, DOM-free). Legacy used an offscreen canvas +
   Path2D + isPointInPath; replaced with ray-casting so the engine imports
   and runs cleanly under node.
   ===================================================================== */
function parsePathPoints(d) {
  return [...String(d || '').matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)].map(m => [+m[1], +m[2]]);
}
function pointInPolygon(pts, x, y) {
  let insidePoly = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y)) {
      const xInt = xi + (y - yi) * (xj - xi) / (yj - yi);
      if (x < xInt) insidePoly = !insidePoly;
    }
  }
  return insidePoly;
}

function buildDistrict(def, rng = Math.random) {
  const d = Object.assign({}, def);
  d.nb = Array.isArray(def.nb) ? def.nb.slice() : [];
  d.poly = parsePathPoints(def.d);
  d.path = typeof Path2D !== 'undefined' ? new Path2D(def.d) : null;
  const nums = d.poly;
  d.bb = [
    Math.min(...nums.map(n => n[0])), Math.min(...nums.map(n => n[1])),
    Math.max(...nums.map(n => n[0])), Math.max(...nums.map(n => n[1])),
  ];
  d.pts = [];
  let guard = 0;
  while (d.pts.length < 30 && guard++ < 8000) {
    const x = d.bb[0] + rng() * (d.bb[2] - d.bb[0]);
    const y = d.bb[1] + rng() * (d.bb[3] - d.bb[1]);
    const m = 9;
    if ([[0, 0], [m, 0], [-m, 0], [0, m], [0, -m]].every(([ox, oy]) => pointInPolygon(d.poly, x + ox, y + oy))) {
      if (Math.hypot(x - def.c[0], (y - def.c[1]) * 1.6) < 30) continue;
      d.pts.push([x, y]);
    }
  }
  if (!d.pts.length) d.pts.push([def.c[0], def.c[1] + 20]);
  d.trapPts = d.pts.length >= 23 ? d.pts.slice(20, 23) : d.pts.slice(-3);
  d.proto = { psn: false, traps: false, fog: false, clinic: false };
  d.flash = 0;
  return d;
}

function inside(d, x, y) {
  if (!d) return false;
  if (!d.poly) d.poly = parsePathPoints(d.d || (d.path && d.path.d) || '');
  return pointInPolygon(d.poly, x, y);
}

function districtAt(mapX, mapY, districts) {
  if (!Array.isArray(districts)) return null;
  for (const d of districts) {
    if (d && inside(d, mapX, mapY)) return d;
  }
  return null;
}

/* =====================================================================
   HELPER MATH (extracted from legacy refreshModel / preventionFactor /
   forecast / spawnCount, lines ~1743-1783 of index.html). These kernels
   are module-private; computeDistrictDrivers is the public consumer.
   ===================================================================== */

/* Lazy singleton: decoding the 52,220-parameter weight buffer on import is
   wasteful for consumers that only need geography. Decodes on first use. */
let _epiModel = null;
function getEpiModel() {
  if (!_epiModel) _epiModel = EpiRuntime.create(MODEL_DATA);
  return _epiModel;
}

/* Legacy refreshModel: re-run inference for the current turn and mutate the
   district outlooks in place. Returns the forecast map. */
function refreshForecasts(districts, turn = 0, modelHistory = {}) {
  if (!Array.isArray(districts)) return {};
  const model = getEpiModel();
  const forecasts = model.predictAll(Math.min(turn, 6), modelHistory);
  for (const d of districts) {
    d.outlook = forecasts[d.id];
    d.epi = d.outlook[0];
  }
  return forecasts;
}

/* Legacy preventionFactor: PSN multiplier x dispatch stance x pool pressure. */
function preventionFactor(d, context = {}) {
  const rules = Object.assign({}, ENGINE_RULES, context.rules || {});
  const prevention = Number.isFinite(context.prevention) ? context.prevention : 0;
  const referencePools = Number.isFinite(d.referencePools) ? d.referencePools : (d.pools || 0);
  const poolFactor = clamp(1 + ((d.pools || 0) - referencePools) * rules.poolStep, 0.8, 1.3);
  return (d.proto && d.proto.psn ? rules.psnFactor : 1) * (1 - prevention) * poolFactor;
}

/* Legacy forecast: horizon-0 reflects REVEALED surveillance only; horizon-1
   carries ~50% persistence of revealed shocks. climateProfile scales the
   model mean as a feature-space perturbation (MODEL_DATA untouched). */
function forecast(d, horizon = 0, climateProfile = 'baseline') {
  const climate = climateProfileOf(climateProfile);
  const base = d.outlook && d.outlook[horizon] ? d.outlook[horizon].mu : (d.epi ? d.epi.mu : 0);
  const adjusted = base * climate.mu;
  if (horizon === 0) {
    const shock = d.revealedShockMult || 1.0;
    return Math.max(0, Math.round(adjusted * shock + (d.revealedDelayedCases || 0)));
  }
  const shockH2 = 1.0 + ((d.revealedShockMult || 1.0) - 1.0) * 0.5;
  return Math.max(0, Math.round(adjusted * shockH2));
}

/* Legacy spawnCount: wild-mosquito pressure from TRUE (hidden) shocks, model
   mean, exceedance probability and pool density. climateProfile perturbs the
   mobility/rainfall-driven pressure term. */
function spawnCount(d, options = {}) {
  const climate = climateProfileOf(options.climateProfile || 'baseline');
  const turn = Number.isInteger(options.turn) ? options.turn : 0;
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const mutators = Array.isArray(options.mutators) ? options.mutators : [];
  const scale = (MODEL_DATA.districts && d.id && MODEL_DATA.districts[d.id])
    ? MODEL_DATA.districts[d.id].scale
    : Math.max(1, (d.epi && d.epi.mu) || 1);
  const draw = 0.82 + 0.36 * rng();
  const shock = d.trueShockMult || 1.0;
  const effectiveMu = (d.epi ? d.epi.mu : 0) * shock + (d.trueDelayedCases || 0);
  let pressure = (3 + 4 * effectiveMu / Math.max(1, scale) + 4 * (d.epi ? (d.epi.eventProb || 0) : 0) + (d.pools || 0) * 0.18) * draw;
  if (mutators.includes('monsoon')) pressure *= 1 + Math.min(0.6, turn * 0.1);
  pressure *= (Number.isFinite(options.spawnMod) ? options.spawnMod : 1)
    * (d.proto && d.proto.psn ? 0.5 : 1)
    * (mutators.includes('swarm') ? 1.4 : 1)
    * climate.pressure;
  return Math.max(2, Math.round(clamp(pressure, 3, 26)));
}

/* Normalize a districts argument (array of district objects, or an id->d map)
   into an id->district lookup. */
function normalizeDistricts(districts) {
  if (!districts) return null;
  if (Array.isArray(districts)) {
    const map = {};
    for (const d of districts) if (d && d.id) map[d.id] = d;
    return map;
  }
  return districts;
}

/* =====================================================================
   FEATURE ENGINEERING & EPIDEMIOLOGICAL DRIVERS
   Extracted from legacy computeDistrictDrivers. Signature:
     computeDistrictDrivers(d, context)
   context (all optional):
     turn           - campaign month index (default 0)
     months         - MONTHS-like array [{ m, name, rain, intensity, poolDelta }]
     month          - single month object (overrides months[turn])
     districts      - array or id->d map for neighbor spillover lookup
     lang           - 'en' | 'id' (default 'en')
     prevention     - G.prevention dispatch-stance fraction (default 0)
     rules          - overrides for { psnFactor, poolStep } engine constants
     climateProfile - 'baseline' | 'el_nino_drought' | 'monsoon_surge' | 'urban_commuter'
   Returns an array of driver rows { name, val, valText, dir, badge, icon, desc }.
   icon is a stable text token (never an emoji).
   ===================================================================== */
function computeDistrictDrivers(d, context = {}) {
  const isId = context.lang === 'id';
  const turn = Number.isInteger(context.turn) ? context.turn : 0;
  const prevention = Number.isFinite(context.prevention) ? context.prevention : 0;
  const rules = Object.assign({}, ENGINE_RULES, context.rules || {});
  const climate = climateProfileOf(context.climateProfile || 'baseline');
  const months = Array.isArray(context.months) ? context.months : null;
  const M = context.month || (months ? months[turn] : null);
  const districtMap = normalizeDistricts(context.districts);
  const drivers = [];

  const snapshot = MODEL_DATA.snapshots[Math.min(turn, 6)];
  const dataIndex = snapshot.issue - MODEL_DATA.history0;
  const source = MODEL_DATA.districts[d.id] || {};

  // 1. Prior-Month Lagged Rainfall (~4 weeks lag)
  const curRain = (source.rain && source.rain[dataIndex]) || 180;
  const lagRain = (source.rain && source.rain[dataIndex - 1]) || curRain;
  const validRain = (source.rain || []).filter(x => x !== null && !isNaN(x));
  const histRainMean = validRain.length ? (validRain.reduce((a, b) => a + b, 0) / validRain.length) : 250;
  const rainDiff = (lagRain - histRainMean) / Math.max(1, histRainMean);
  // Climate overlay nudges the rainfall signal shown to the player.
  const climateRainBias = Math.round((climate.rainfall - 1) * 40);
  const rainInfluence = Math.round(clamp(rainDiff * 40 + climateRainBias, -35, 45));
  drivers.push({
    name: isId ? 'Hujan Lalu (~4 mggu)' : 'Prior Rain Lag (~4w)',
    val: rainInfluence,
    valText: (rainInfluence >= 0 ? '+' : '') + rainInfluence + '%',
    dir: rainInfluence >= 0 ? 'up' : 'down',
    badge: isId ? 'Indikatif' : 'Indicative',
    icon: 'rain',
    desc: isId
      ? `Curah hujan bulan lalu (${Math.round(lagRain)} mm vs rerata wilayah ${Math.round(histRainMean)} mm) menentukan habitat jentik`
      : `Prior-month rain (${Math.round(lagRain)} mm vs district mean ${Math.round(histRainMean)} mm) sets larval habitat density`,
  });

  // 2. Standing Water / Breeding Pools
  const poolDiff = (d.pools || 0) - (Number.isFinite(d.referencePools) ? d.referencePools : (d.pools || 0));
  const poolInfluence = Math.round(clamp(poolDiff * 9, -40, 45));
  if (poolInfluence !== 0) {
    drivers.push({
      name: isId ? `Genangan Air (${d.pools})` : `Breeding Pools (${d.pools})`,
      val: poolInfluence,
      valText: (poolInfluence >= 0 ? '+' : '') + poolInfluence + '%',
      dir: poolInfluence >= 0 ? 'up' : 'down',
      badge: isId ? 'Indikatif' : 'Indicative',
      icon: 'pool',
      desc: isId
        ? `${d.pools} genangan air mikro (${poolDiff >= 0 ? '+' : ''}${poolDiff} vs acuan normal)`
        : `${d.pools} standing water micro-pools (${poolDiff >= 0 ? '+' : ''}${poolDiff} vs reference)`,
    });
  }

  // 3. Monsoon Season Curve (skipped when no month context is supplied)
  if (M) {
    const seasonInfluence = Math.round((M.intensity - 0.95) * 60);
    if (seasonInfluence !== 0) {
      const sName = M.name || '';
      const mLabel = M.m || '';
      drivers.push({
        name: isId ? `Musim ${mLabel} (${sName})` : `${mLabel} Season (${sName})`,
        val: seasonInfluence,
        valText: (seasonInfluence >= 0 ? '+' : '') + seasonInfluence + '%',
        dir: seasonInfluence >= 0 ? 'up' : 'down',
        badge: isId ? 'Indikatif' : 'Indicative',
        icon: 'season',
        desc: isId
          ? `Intensitas siklus iklim monsun tropis (${Number(M.intensity).toFixed(2)}x)`
          : `Monsoon seasonal cycle intensity (${Number(M.intensity).toFixed(2)}x)`,
      });
    }
  }

  // 4. Urban Host Density
  const popVal = parseFloat(d.pop) || 1.0;
  const popInfluence = Math.round(clamp((popVal - 0.9) * 16, -20, 25));
  if (popInfluence !== 0) {
    drivers.push({
      name: isId ? `Kepadatan Warga (${d.pop})` : `Host Density (${d.pop})`,
      val: popInfluence,
      valText: (popInfluence >= 0 ? '+' : '') + popInfluence + '%',
      dir: popInfluence >= 0 ? 'up' : 'down',
      badge: isId ? 'Indikatif' : 'Indicative',
      icon: 'density',
      desc: isId
        ? 'Kepadatan populasi perkotaan memperbesar frekuensi kontak gigitan'
        : 'Urban population density creates contact opportunities',
    });
  }

  // 5. Commuter & Neighbor Spillover (requires district lookup context).
  // Mobility weight grows under urban_commuter climate overlay.
  if (d.nb && d.nb.length && districtMap) {
    const neighborCases = d.nb.map(id => districtMap[id] && Number.isFinite(districtMap[id].cases) ? districtMap[id].cases : null).filter(v => v !== null);
    if (neighborCases.length) {
      const avgNbCases = neighborCases.reduce((a, b) => a + b, 0) / neighborCases.length;
      const mobilityGain = climate.mobility - 1.0;
      const nbInfluence = Math.round(clamp(((avgNbCases - 110) / 110) * 20 * (1 + mobilityGain), -15, 25 + Math.round(mobilityGain * 20)));
      if (Math.abs(nbInfluence) >= 5) {
        drivers.push({
          name: isId ? 'Sebaran Transit Komuter' : 'Transit Spillover',
          val: nbInfluence,
          valText: (nbInfluence >= 0 ? '+' : '') + nbInfluence + '%',
          dir: nbInfluence >= 0 ? 'up' : 'down',
          badge: isId ? 'Indikatif' : 'Indicative',
          icon: 'transit',
          desc: isId
            ? `Mobilitas komuter dari ${d.nb.length} wilayah tetangga`
            : `Commuter mobility from ${d.nb.length} neighboring districts`,
        });
      }
    }
  }

  // 6. Active Player Interventions
  if (d.proto && d.proto.psn) {
    const psnPct = -Math.round((1 - rules.psnFactor) * 100);
    drivers.push({
      name: isId ? 'PSN 3M Plus' : 'Source Clean-up (PSN)',
      val: psnPct,
      valText: psnPct + '%',
      dir: 'down',
      badge: 'Rule x' + rules.psnFactor,
      icon: 'psn',
      desc: isId
        ? `Aksi PSN kuras 5 genangan dan kalikan kasus dengan ${rules.psnFactor}x`
        : `Clean-up drains 5 pools and applies ${rules.psnFactor}x case multiplier`,
    });
  }
  if (d.proto && d.proto.fog) {
    drivers.push({
      name: isId ? 'Fogging Fokus' : 'Targeted Fogging',
      val: -20,
      valText: isId ? '80% lumpuh/3 dtk' : '80% hit/3s',
      dir: 'down',
      badge: isId ? 'Knockdown Tempur' : 'Combat Knockdown',
      icon: 'fog',
      desc: isId
        ? 'Semburan aerosol melumpuhkan nyamuk dewasa tiap 3 detik selama aksi'
        : 'Area aerosol burst damages wild vectors every 3s to reduce bites',
    });
  }
  if (d.proto && d.proto.traps) {
    drivers.push({
      name: isId ? 'Ovitrap Letal' : 'Ovitraps',
      val: -15,
      valText: isId ? 'Jebak Otomatis' : 'Auto-Catch',
      dir: 'down',
      badge: isId ? 'Otonom' : 'Autonomous',
      icon: 'traps',
      desc: isId
        ? 'Ovitrap otomatis menangkap nyamuk betina bertelur di titik sarang'
        : 'Continuous traps auto-capture nearby vectors during the wave',
    });
  }
  if (prevention > 0) {
    const prevPct = -Math.round(prevention * 100);
    drivers.push({
      name: isId ? 'Sosialisasi Warga' : 'Public Awareness',
      val: prevPct,
      valText: prevPct + '%',
      dir: 'down',
      badge: isId ? 'Kebijakan Pemda' : 'Dispatch Stance',
      icon: 'awareness',
      desc: isId
        ? 'Arahan kebijakan pemerintah daerah meningkatkan kesiagaan mandiri warga'
        : 'Municipal dispatch stance boosts community barrier defense',
    });
  }

  // 7. Surveillance Shocks
  const revShock = d.revealedShockMult || 1.0;
  const revDelayed = d.revealedDelayedCases || 0;
  if (revShock !== 1.0 || revDelayed > 0) {
    const shockPct = Math.round((revShock - 1.0) * 100 + (revDelayed / Math.max(1, d.cases || 15)) * 30);
    drivers.push({
      name: isId ? 'Kejutan Surveilans' : 'Surveillance Shock',
      val: shockPct,
      valText: (shockPct >= 0 ? '+' : '') + shockPct + '%',
      dir: shockPct >= 0 ? 'up' : 'down',
      badge: isId ? 'Terungkap' : 'Revealed',
      icon: 'shock',
      desc: isId
        ? 'Laporan surveilans lapangan merevisi estimasi tekanan kasus'
        : 'Surveillance reports revised expected case pressure',
    });
  }

  return drivers;
}

/* =====================================================================
   RISK CLASSIFICATION
   Standardized bands against an outbreak threshold. Returns the RISK index
   (0 SAFE | 1 ELEVATED | 2 HIGH | 3 CRITICAL). Display bands are game UI
   rules, not frozen scientific alert cutoffs.
   ===================================================================== */
function riskOf(predCases, outbreakThreshold) {
  const p = Math.max(0, Number(predCases) || 0);
  const t = Number(outbreakThreshold);
  if (!Number.isFinite(t) || t <= 0) return p > 0 ? 3 : 0;
  const r = p / t;
  if (r < 0.5) return 0;
  if (r < 0.8) return 1;
  if (r < 1.0) return 2;
  return 3;
}

export {
  EpiRuntime,
  DISTRICT_DEFS,
  RIVERS,
  RISK,
  buildDistrict,
  inside,
  districtAt,
  computeDistrictDrivers,
  riskOf,
};
