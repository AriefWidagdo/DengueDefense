# 03 — Diegetic Copywriting, Complete EN/ID I18N & Optional EpiKD Lab Drawer

> **Core Directive (Confirmed with User):** Active gameplay screens, HUD bars, district cards, dispatch briefings, and post-wave reports MUST sound like a cohesive **Satgas DBD Regional Command Post** — urgent, punchy, tactile, and zero-jargon. **All scientific disclaimers, PyTorch checkpoint provenance, NB2 math explanations, and sequential waterfall attribution checks are moved cleanly into an optional `"EpiKD Lab & Field Manual"` slide-over drawer** (`js/ui/epikd-lab.js`).

---

## 1. Anti-"Vibe-Code" Copy Audit: What Gets Stripped From Gameplay

| Legacy Text (`MainGame/index.html`) | Problem | Replacement Strategy |
| :--- | :--- | :--- |
| *"Forecasts are model outputs, not guarantees"* | Breaks immersion immediately on main HUD/modals | **Remove from gameplay HUD.** Place inside `EpiKD Lab -> Model Scope & Assumptions`. |
| *"Policy effects are game rules, not calibrated parameters"* | Exposes scaffolding & feels like an apologetic footnote | **Remove from gameplay HUD.** Place inside `EpiKD Lab -> Simulation Mechanics`. |
| *"Upgrades change game rules, not model behavior"* | Technical disclaimer clutter during perk selection | **Remove from Perk Modal.** Describe perks purely via concrete field effects (`-1 PSN cost`, `+50 Ward Beds`). |
| `"+3% GAME PREVENTION"` / `"P+T+F 44% -> +28%"` micro-jargon chips | Cryptic developer shorthand in card corners | Replace with clean command metric: **`Mitigation: 44%`** or **`Coverage: PSN + Ovitrap`**, with full math breakdown only if clicking **`[ Inspect Telemetry ]`** -> opens `EpiKD Lab`. |
| `"Attribution check: Base 18 + Shock +2 + Prevention -6 = 14 ✓"` | Raw debug/unit-test string printed directly to player UI | **Remove `"Attribution check ... ✓"` from Wave Report.** Render a diegetic 3-bar visual **"Outbreak Outcome"** summary (`Baseline Projected -> Containment Prevented -> Final Active Cases`), and put the exact additive waterfall equation inside `EpiKD Lab -> Wave Audit`. |
| `"EpiKD KDA checkpoint model_kda_17.pt (52,220 params)"` on main title | Academic paper abstract energy on a game splash screen | Replace title subtitle with: **"Central Java Outbreak Command • Tactical Containment Across 6 Regencies"**, and link a discrete header pill **`EpiKD Lab`** for curious players / researchers. |

---

## 2. Game Title, Voice & Terminology Lexicon

- **Title (EN):** **DENGUE DEFENSE** — *Field Edition*
- **Title (ID):** **DENGUE DEFENSE** — *Edisi Lapangan*
- **Voice:** Concise military/public-health field operations dispatch. Short imperative verbs (`Deploy`, `Isolate`, `Purge`, `Triage`, `Intercept`). Numbers lead; prose supports.
- **Canonical Action & Unit Names (Zero Mixed Naming):**

| Internal ID | English Label (`en`) | Indonesian Label (`id`) | Concise Field Tooltip (No Disclaimers) |
| :--- | :--- | :--- | :--- |
| `psn` | **Source Cleanup (PSN)** | **PSN 3M Plus** | Clears larval habitats around homes; cuts monthly baseline pressure. |
| `traps` | **Lethal Ovitraps** | **Ovitrap Mematikan** | Eliminates egg-laying females entering perimeter wards. |
| `fog` | **Thermal Fogging** | **Fogging Terfokus** | Rapid knockdown of adult swarms; high cost, slight ecology penalty if spammed. |
| `clinic` | **Field Triage Ward** | **Posko Triage Lapangan** | Expands local bed surge capacity and slows systemic fever panic. |
| `ping` | **Surveillance Sweep** | **Patroli Surveilans** | Reveals concealed weather/transit anomalies in the selected regency. |
| `quarantine` | **Cordon Border** | **Sekat Perbatasan** | *(Mode 2)* Cuts inter-regency commuter transmission along one shared border for 2 turns. |

---

## 3. Complete EN & ID I18N Contract (`MainGame/site/js/i18n.js`)

In the legacy prototype (`MainGame/index.html` lines 1417–1650), `DISPATCHES_LANG.en` and `MONTHS_LANG` were partially asymmetric or inline. `js/i18n.js` MUST establish **100% key parity between `en` and `id`**, validated cleanly:

### Required API
```js
export const I18N_PACKS = { en: { ... }, id: { ... } };
export function getLang();           // returns 'en' | 'id', persisted in localStorage['dd_lang']
export function setLang(lang);       // updates state + document.documentElement.lang + triggers re-render callback
export function toggleLanguage();    // toggles en <-> id cleanly
export function t(key, vars = {});   // interpolates {count}, {district}, {percent} with fallback warning only in dev
export function applyStaticI18n();   // hydrates [data-i18n] and [data-i18n-title] nodes in index.html
```

### Key Coverage Families (Every Key Must Exist in Both `en` and `id`)
1. `hub.*` — Title, Tagline, Mode 1/2/3 cards (estimated duration, mechanic tags, best score badge), Doctrine selector descriptions, Seed & Mutator drawers.
2. `hud.*` — Phase indicators (`BRIEFING`, `DEPLOYMENT`, `ACTIVE INTERCEPT`, `TRIAGE REPORT`, `WEEK {n}/8`, `BLITZ TIME`), Budget (`Funds`, `AP`), ICU Load, Threat Tiers (`LOW`, `ELEVATED`, `HIGH`, `CRITICAL`), Buttons (`Launch Wave`, `Commit Turn`, `EpiKD Lab`, `Pause`, `Hub`).
3. `mode1.*` — 4 Scenarios (`solo_basin`, `merapi_ashfall`, `bengawan_flood`, `commuter_corridor`), Monthly Command Directives (6 rewritten high-stakes trade-off dispatches), 6 Shock Alert strings (`rain_spike`, `reporting_lag`, `transit_cluster`, `forecast_revision_down`, `community_drain`, `larvae_bloom`), 12 Field Perks.
4. `mode2.*` — 8-week Crisis Board directives, Action names (`Quarantine`, `Ovitraps`, `Ward Surge`, `Larvicide`, `Surveillance`), Weekly Event Cards (12 curated crisis twists), Victory / Collapse debrief strings.
5. `mode3.*` — Blitz announcer cues (`SWARM BREACH`, `COMBO x3`, `BREEDING POOL CRITICAL`, `AIRSTRIKE READY`, `FINAL 30 SECONDS`), Rank grades (`S`, `A`, `B`, `C`, `D`).
6. `epikd.*` — Complete technical copy for the optional **EpiKD Lab & Field Manual** drawer (isolated cleanly from gameplay keys).
7. `lb.*` & `end.*` — Per-mode leaderboard headers, submission prompt, rank feedback, Offline fallback, Share Run card string.

---

## 4. The Optional `EpiKD Lab & Field Manual` Drawer (`MainGame/site/js/ui/epikd-lab.js`)

This drawer honors the research roots of **EpiKD KDA** as a value-add feature for curious players, students, and epidemiologists—accessible via the subtle **`EpiKD Lab`** pill in the top bar or Hub, never forced during combat or planning.

### Exports
```js
export function openEpikdLab(initialTab = 'model'); // 'model' | 'drivers' | 'audit' | 'manual'
export function closeEpikdLab();
export function openWaveAttributionAudit(districtId); // opens Drawer directly to 'audit' tab for active/last wave
```

### Four Sub-Tabs Inside the Slide-Over Drawer
1. **Tab 1: `Model Card` (`model`)**
   - Houses the factual checkpoint telemetry from `MODEL_DATA.meta`:
     - Engine: `EpiKD KDA` (`checkpoint: model_kda_17.pt`, `backbone: kda`, `params: 52,220`, `seed: 17`, `lookback: 24 months`).
     - Statistical Output: Negative Binomial (`NB2`) predictive distribution (`mu`, `alpha`), IQR quantile band (`Q25–Q75`), `P90` upper tail, and exceedance probability over endemic threshold.
     - Explicit Research Note (previously polluting gameplay cards): Clarifies that forecasts are statistical model outputs conditioned on historical surveillance & climate covariates, while `GAME_RULES` prevention factors (`PSN`, `Ovitrap`, `Fog`, `Clinic`) are calibrated tactical mechanics.
2. **Tab 2: `District Drivers` (`drivers`)**
   - Displays `computeDistrictDrivers()` live output for whichever district the player selects:
     - Prior-month case momentum (`lag1`), 3-month trend, seasonal harmonic angle (`NOV–APR`), rainfall/climate index, and inter-district spillover pressure from `nb` neighbors.
     - Crisp horizontal bar visualization comparing positive pressure vs. active mitigation.
3. **Tab 3: `Waterfall Audit` (`audit`)**
   - Displays the exact additive decomposition previously jammed into `showDistrictWaveAudit` / `showRegionalWaveAudit`:
     - `EpiKD Baseline` + `Climate/Shock Delta` -> `Gross Vector Pressure`
     - Minus `Protocol Prevention` (`PSN / Trap / Fog`) -> `Effective Target`
     - Minus `Field Interception` (Swats + Pool Drains / Perfect Intercept Bonus) -> `Actual Cases Recorded`
   - Includes regional rollup across all 6 regencies with zero immersion-breaking `"✓"` debug strings—rendered instead as a crisp financial-style accounting ledger.
4. **Tab 4: `Field Manual` (`manual`)**
   - Concise visual reference of Mosquito Archetypes, Protocol Synergies (`PSN + Ovitrap` stacking rule), Commander Doctrines, and Keyboard/Touch controls per mode.
