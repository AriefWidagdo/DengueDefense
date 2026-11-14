# 01 — Core Architecture, ES Module Layout & Epidemiological Engine Extraction

> **Target Game Title:** *Dengue Defense — Field Edition* (Satgas DBD: Solo–Yogya Corridor)  
> **Source Legacy File:** `MainGame/index.html` (4,480-line single-file prototype) & `MainGame/site/index.html`  
> **Build Target:** Clean multi-file ES modules (`type="module"`) under `MainGame/site/`, served locally via `MainGame/dev-server.mjs` and deployable directly via `MainGame/wrangler.jsonc` (`assets.directory = "./site"`).

---

## 1. Architectural Shift: Why We Are Splitting the Monolith

The legacy prototype packs CSS (lines 17–524), DOM markup (lines 527–644), serialized neural weights (`MODEL_DATA`, line 645), epidemiological inference (`EpiRuntime`, lines 646–860), audio synth, simulation state, map rendering, UI chrome, and debug/science audit modals into a single 4,480-line HTML file (`MainGame/index.html` / `MainGame/site/index.html`).

For commercial maintainability and parallel multi-agent implementation:
1. **Zero inline monolithic HTML**: `MainGame/site/index.html` becomes a lean semantic shell (< 180 lines) loading stylesheet layers (`tokens.css`, `layout.css`, `components.css`) and `<script type="module" src="./js/main.js"></script>`.
2. **Strict Separation of Concerns**:
   - **Data & Weights** (`js/epi-data.js`) isolated from **Inference Math** (`js/epi-engine.js`) so no agent touches raw base64 weight blobs unnecessarily.
   - **Shared Rules, Doctrines & Mutable State** (`js/state.js`) cleanly decouple deterministic RNG, campaign state (`G`), and wave state (`W`) from UI DOM mutation.
   - **Three Game Modes** (`js/modes/operations.js`, `js/modes/crisis-board.js`, `js/modes/blitz.js`) implement a uniform lifecycle interface managed by `js/main.js`.
   - **Science/Waterfall Telemetry** lives solely in `js/ui/epikd-lab.js`, leaving active gameplay HUD (`js/ui/hud.js`) and overlays (`js/ui/modals.js`) 100% diegetic.
3. **Preserve Legacy Compatibility**: Keep `MainGame/site/` static-hostable on Cloudflare Workers (`MainGame/wrangler.jsonc` already points `assets.directory` to `./site`) with zero required bundler step (native ES modules + relative imports).

---

## 2. Target Directory & Module Contract (`MainGame/site/`)

Every build agent MUST adhere to the exact file paths and named ES module exports below:

```text
MainGame/
  dev-server.mjs              # Updated static MIME server for ./site/* + /api/* Worker proxy
  wrangler.jsonc              # Existing: assets.directory = "./site" (no structural change needed)
  worker/
    schema.sql                # Updated: adds mode, doctrine, scenario columns + composite index
    src/index.js              # Updated: per-mode GET /api/top & POST /api/submit validation
  tests/
    test_leaderboard.py       # Updated: multi-file site/ checks + Mode 1/2/3 & LB_API E2E tests
  site/
    index.html                # Semantic shell, SVG <defs> sprite sheet, HUD containers, modal roots
    css/
      tokens.css              # Design tokens (palette, elevation, typography, z-index, spacing)
      layout.css              # Command-center responsive grid, full-bleed canvas stage, mobile drawer
      components.css          # Tactical buttons, cards, gauges, badges, EpiKD lab drawer styles
    js/
      epi-data.js             # Verbatim extraction of MODEL_DATA (legacy index.html line 645)
      epi-engine.js           # EpiRuntime + geography polygons/rivers + driver & risk computation
      state.js                # GAME_RULES, MODES, DOCTRINES, MONTHS, MUTATORS, PERKS, ACHIEVEMENTS, G/W state
      sprites.js              # Zero-emoji inline SVG registry + Canvas 2D map & vector entity renderers
      audio.js                # WebAudio synth (SFX), mute/haptics toggles, intensity-adaptive feedback
      i18n.js                 # Dual-language EN / ID tactical command packs & clean DOM translator
      map-renderer.js         # Canvas projection (toScreen/toMap), FX particles, resize, layer orchestrator
      modes/
        operations.js         # Mode 1: Monsoon Operations (hybrid tactical plan + reflex wave campaign)
        crisis-board.js       # Mode 2: Crisis Board (8-week pure turn-based epidemiological puzzle)
        blitz.js              # Mode 3: Outbreak Blitz (2:30 continuous real-time arcade score-attack)
      ui/
        hud.js                # Mode-aware top bar, collapsible right/bottom drawer, toasts, banners
        modals.js             # Mode Hub, Doctrine selector, Pause, Badges, End/Debrief overlay
        epikd-lab.js          # Optional "EpiKD Lab & Field Manual" drawer (disclaimers, NB2 math, waterfall)
      leaderboard.js          # LB_API resolution, /api/top & /api/submit client, share card generator
      main.js                 # Entrypoint: RAF loop, pointer/keyboard dispatch, mode router, URL params
```

---

## 3. Exact ES Module Interface Specifications

### 3.1 `MainGame/site/js/epi-data.js`
- **Source:** `MainGame/index.html` line 645 (`const MODEL_DATA = {...};`).
- **Exports:**
  ```js
  export const MODEL_DATA = { /* verbatim object extracted from MainGame/index.html line 645 */ };
  ```
- **Rule:** Do **not** alter keys, base64 strings, scales, offsets, or metadata inside `MODEL_DATA` (`version: 1`, `meta.name: "EpiKD KDA"`, `meta.checkpoint: "model_kda_17.pt"`, `meta.info.backbone: "kda"`, `seed: 17`, `params: 52220`). Simply prepend `export ` so ES modules import it without polluting global scope (`MODEL_DATA` may optionally be attached to `window.MODEL_DATA` inside `main.js` only if external inspection scripts need it, though prefer clean module imports).

### 3.2 `MainGame/site/js/epi-engine.js`
- **Imports:** `{ MODEL_DATA } from './epi-data.js'`
- **Source:**
  - `EpiRuntime` IIFE from `MainGame/index.html` lines 646–860 (`create`, `nbTail`, `nbQuantile`, `sample`, internal 24-month lookback, KDA linear-attention block, NB2 `logGamma`, `betaFraction`, `betaInc`).
  - `DISTRICT_DEFS` (6 districts: `boyolali`, `surakarta`, `sleman`, `klaten`, `sukoharjo`, `gunungkidul` with SVG path strings `d`, centroids `c`, adjacency `nb`) and `RISK` (`SAFE`, `ELEVATED`, `HIGH`, `CRITICAL`) from lines 1041–1197.
  - `RIVERS`, `buildDistrict`, `inside` from lines 1200–1259.
  - `computeDistrictDrivers` (and helper math extracted from `refreshModel`, `preventionFactor`, `forecast`, `spawnCount`, lines 1706–2043).
- **Required Exports:**
  ```js
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
  ```
- **Additions / Cleanups inside `epi-engine.js`:**
  1. `districtAt(mapX, mapY, districts)`: canonical point-in-polygon hit tester using `inside()` over prebuilt district polygons (`buildDistrict`), returning the district object or `null`.
  2. `riskOf(predCases, outbreakThreshold)`: standardized classification against `RISK` (`SAFE`, `ELEVATED`, `HIGH`, `CRITICAL`) without raw string allocation bugs.
  3. **Scenario Climate Overlays**: Accept an optional `climateProfile` modifier (`baseline`, `el_nino_drought`, `monsoon_surge`, `urban_commuter`) passed into forecast/spawn computation so Mode 1 selectable scenarios and Mode 2 puzzles can perturb rainfall/mobility features fed into `EpiRuntime` without mutating `MODEL_DATA` itself.

### 3.3 `MainGame/site/js/state.js`
- **Imports:** `{ mulberry32, parseSeed, randomSeedWord }` (defined here cleanly), `{ DISTRICT_DEFS }` from `./epi-engine.js`.
- **Source:**
  - `GAME_RULES` (`psnFactor: 0.75`, `drainFactor: 0.94`, `poolStep: 0.025`, `perfectArcadeFactor: 0.65`, `missedArcadeSpan: 0.55`, `careSlots: 240`, `clinicSlots: 150`), `MONTHS` (`NOV`..`APR`), `ACHIEVEMENTS` (10 legacy badges + new mode mastery badges), `MUTATORS` (6 mutators), `PERKS` (12 tactical doctrines/field perks), `scoreMult`, `hasMut`, `freshState` (lines 869–881, 1041–1259, 1706–1800).
- **Required Exports:**
  ```js
  export {
    GAME_RULES,
    MONTHS,
    MODES,
    DOCTRINES,
    SCENARIOS,
    PROTOCOLS,
    MUTATORS,
    PERKS,
    ACHIEVEMENTS,
    freshState,
    mulberry32,
    parseSeed,
    randomSeedWord,
    scoreMult,
    hasMut,
    getG,
    getW,
    setG,
    setW,
  };
  ```
- **Global Test Hook Synchronization (`window.G` and `window.W`):**
  Existing Playwright tests (`MainGame/tests/test_leaderboard.py`) inspect `window.G` (e.g., `G.phase`, `G.mode`, `G.seedStr`, `G.score`) and `window.W` (`W.total`, etc.). Therefore, `setG(nextG)` and `setW(nextW)` MUST update both module-scoped references and mirror them onto `window.G` and `window.W` (`Object.defineProperty` or synchronized assignment on every state transition). Calling `getG()` / `getW()` inside ES modules keeps module imports clean while keeping E2E automation compatible.

---

## 4. Commander Doctrines (`DOCTRINES`) Specification

At the start of **Mode 1 (`operations`)** or **Mode 2 (`crisis_board`)** (and optionally as a passive loadout in **Mode 3 (`blitz`)**), the player chooses one of **3 Commander Doctrines**. Each doctrine changes starting economy, strategic modifiers, and active toolkit flavor—never cosmetic-only fluff:

| Doctrine ID | Display Name (EN / ID) | Core Identity | Starting Modifiers & Rules |
| :--- | :--- | :--- | :--- |
| `surveillance_directorate` | **Surveillance Directorate** / *Direktorat Surveilans* | Information superiority & targeted containment | • Starts with `+15%` Intel Accuracy (fog-of-war shocks reveal 1 turn earlier / surveillance ping costs **35% less**, minimum `2` funds instead of `3`)<br>• **Bonus:** `+1` free District Risk Audit per campaign<br>• **Tradeoff:** Starting Emergency Budget `-2` funds (starts at `16` instead of `18` in Mode 1) |
| `biocontrol_taskforce` | **Bio-Control Taskforce** / *Satgas Biokontrol* | Ecological suppression (PSN, Wolbachia, larvicide) | • `PSN` & `Ovitrap` protocol costs reduced by `-1` fund (min `2`)<br>• Standing-water drain efficiency doubled (`drainFactor` per swiped puddle becomes `0.90` instead of `0.94`, `poolStep` `+0.04` instead of `+0.025`)<br>• **Tradeoff:** Thermal Fogging (`fog`) costs `+1` fund and reduces ecological score bonus by `5%` if overused |
| `rapid_response_corps` | **Rapid Response Corps** / *Korps Reaksi Cepat* | Surge medical capacity & frontline interception | • Field Clinics (`clinicSlots`) provide `+50` extra regional surge capacity (`200` per clinic instead of `150`) and base regional ICU capacity starts at `280` (`+40` over `240`)<br>• Swat slash radius `+18%`, Spray/Containment Ring charge builds `20%` faster on consecutive hits<br>• **Tradeoff:** Passive PSN reduction softened (`psnFactor: 0.80` instead of `0.75`) |

- **State Representation in `G`:**
  - `G.mode`: `'operations' | 'crisis_board' | 'blitz'`
  - `G.doctrine`: `'surveillance_directorate' | 'biocontrol_taskforce' | 'rapid_response_corps'`
  - `G.scenario`: `'solo_basin' | 'merapi_ashfall' | 'bengawan_flood' | 'commuter_corridor'` (in Mode 1; `'regional_board'` in Mode 2; `'solo_blitz'` in Mode 3)

---

## 5. Updating `MainGame/dev-server.mjs` for Multi-File Serving

Currently `MainGame/dev-server.mjs` (lines 38–53) hardcodes reading `./index.html` only for `/` and `/index.html` and returns `404` for everything except `/api/*`. That breaks `.js`, `.css`, and `.svg` ES module imports under `MainGame/site/`.

### Exact Replacement Contract for `MainGame/dev-server.mjs`
Keep lines 1–37 (Node `http`, `DatabaseSync(':memory:')`, schema bootstrap, and `/api/*` delegation to `./worker/src/index.js`), and update the non-API static handler cleanly:
1. Resolve static root explicitly as `const SITE_ROOT = path.resolve(__dirname, 'site');`.
2. Normalize `url.pathname`:
   - Map `/` -> `/index.html`.
   - Strip query string (`url.pathname` already excludes query), decode URI safely (`try { decodeURIComponent(...) } catch { 400 }`).
   - Resolve `const candidate = path.resolve(SITE_ROOT, '.' + cleanPath);`.
   - Enforce directory traversal guard: if `!candidate.startsWith(SITE_ROOT + path.sep) && candidate !== path.join(SITE_ROOT, 'index.html')`, return `403 Forbidden`.
3. Determine MIME type via extension map:
   - `.html`: `text/html; charset=utf-8`
   - `.js`, `.mjs`: `application/javascript; charset=utf-8`
   - `.css`: `text/css; charset=utf-8`
   - `.svg`: `image/svg+xml; charset=utf-8`
   - `.json`: `application/json; charset=utf-8`
   - `.png`: `image/png`
   - `.woff2`: `font/woff2`
4. Set `Cache-Control: no-store` in local dev so module edits reload cleanly in Chromium/Playwright.
5. Also ensure the in-memory SQLite table initialization in `dev-server.mjs` executes the updated `MainGame/worker/schema.sql` (including `mode`, `doctrine`, `scenario`) and exposes `env.DB` accurately to `worker/src/index.js`.

---

## 6. Clean State Lifecycle & Mode Interface Contract

Every mode (`OperationsMode`, `CrisisBoardMode`, `BlitzMode`) MUST export an object implementing a unified lifecycle contract consumed by `MainGame/site/js/main.js`:

```js
// Standard Mode Adapter Contract
export const SomeMode = {
  id: 'operations', // 'operations' | 'crisis_board' | 'blitz'
  supportsPause: true,
  usesRealTimeCanvasLoop: true,

  /** Initialize mode state (G, W), configure district topology, scenario params, and HUD layout */
  init({ seedStr, seed, doctrine, scenario, mutators }) {},

  /** Clean up timers, async shock reveals, or event bindings when exiting back to Command Hub */
  dispose() {},

  /** Called every RAF frame by main.js when mode is active and unpaused */
  update(dt, now) {},

  /** Render mode-specific vector layers on top of the shared topographic corridor canvas */
  render(ctx, view, now) {},

  /** Pointer interaction handlers in map coordinates (mapX, mapY) & screen coordinates */
  onPointerDown(pt, ev) {},
  onPointerMove(pt, ev) {},
  onPointerUp(pt, ev) {},

  /** Keyboard shortcut handler (e.g., 1-4 select district/tool, Space pause/commit, Tab open HUD drawer) */
  onKeyDown(ev) {},

  /** Returns compact HUD descriptor object consumed by js/ui/hud.js */
  getHudSnapshot() {},
};
```

### Verification Checklist for File `01` Implementers
- [ ] `MODEL_DATA` copied byte-for-byte from `MainGame/index.html` line 645 into `MainGame/site/js/epi-data.js`.
- [ ] `EpiRuntime` (`nbTail`, `nbQuantile`, `sample`, `create`) runs identically in `js/epi-engine.js` with zero console errors.
- [ ] `MainGame/dev-server.mjs` serves `MainGame/site/index.html`, `MainGame/site/css/*.css`, and `MainGame/site/js/**/*.js` with `200 OK` and valid `application/javascript` MIME headers.
- [ ] `window.G` and `window.W` stay synchronized for both runtime inspection and automated Playwright tests.
