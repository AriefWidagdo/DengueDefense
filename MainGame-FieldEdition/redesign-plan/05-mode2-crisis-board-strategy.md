# 05 — Mode 2: Crisis Board (Pure Turn-Based Epidemiological Strategy)

> **Target Session Length:** 4–6 minutes (`8` crisp weekly turns)  
> **Core Fantasy:** *District Crisis Board Room* — **zero cursor swatting or reflex arcade play**. Every victory or collapse comes strictly from spatial contagion containment, predictive model reading, action-point economy, and anticipation of stochastic climate/commuter events.  
> **Commercial Value:** Captures strategy/puzzle players (*Into the Breach*, *Pandemic*) on both desktop and mobile portrait/landscape without frantic swiping.

---

## 1. Core Loop Architecture (`MainGame/site/js/modes/crisis-board.js`)

Exports `CrisisBoardMode` adhering to the standard Mode Adapter Contract (`id: 'crisis_board'`, `usesRealTimeCanvasLoop: true` for smooth map animations & pulse cues only, `supportsPause: true`).

### Campaign Structure: 8 Weekly Turns (`WEEK 1/8` -> `WEEK 8/8`)
Each week executes cleanly in **3 deterministic sub-phases**:
1. **INTEL BRIEFING (Turn Start)**
   - `EpiRuntime` evaluates current regional vector states + 24-month rolling history + active climate/commuter modifiers across all 6 regencies (`boyolali`, `surakarta`, `sleman`, `klaten`, `sukoharjo`, `gunungkidul`).
   - Displays **Telegraphed Threat Vectors** directly on the map:
     - **Red Directional Flow Arrows** between adjacent `nb` districts showing commuter spillover (`e.g. Surakarta -> Klaten +6 projected cases`).
     - **District Threat Meter** (`Median + Q25–Q75 + Exceedance Risk`).
   - Draws **1 Weekly Event Twist** (deterministic from run `seed` via `mulberry32`, or previewed early with Surveillance): e.g., *Merapi Orographic Downpour*, *Solo Station Market Surge*, *Volunteer Kader Drive*, *Clinic Generator Fault*.
2. **COMMAND ALLOCATION (Player Turn — `3 AP` base + unspent carryover up to `+1 AP`)**
   - Player selects districts or shared adjacency borders on the interactive canvas and spends **Action Points (`AP`)** to deploy tactical orders.
   - **Real-Time Dry-Run Preview:** Hovering or queueing an action updates projected weekly spillover arrows and net case deltas *before* clicking **`[ END WEEK / RESOLVE ]`**, giving deep tactical puzzle satisfaction (*Into the Breach*-style clarity).
3. **WEEKLY RESOLUTION (Animated 1.5s Map Simulation)**
   - Sequential animated ticks on the canvas:
     1. Borders lock/flash where **Quarantine Cordons** block spillover.
     2. Containment pulses trigger inside treated districts.
     3. Net spillover flows along unblocked corridors.
     4. Hospital Ward Load updates (`0` -> `cap`), decaying naturally via recovered beds (`-18` base weekly discharges, boosted by `Clinic Surge`).

---

## 2. Tactical Action Palette (Exact Costs, Rules & Counters)

Players start each week with **`3 AP`** (max **`4 AP`** if saving 1 AP from prior turn; **`surveillance_directorate`** gains `+1` free *Deep Surveillance* charge on Weeks 1 and 5).

| Action ID | Display Name (EN / ID) | AP Cost | Targeting | Exact Mechanical Effect |
| :--- | :--- | :--- | :--- | :--- |
| `cordon` | **Border Cordon** / *Sekat Perbatasan* | `1 AP` | Click any **shared border segment** between two `nb` districts | Draws a yellow/black hazard line (`drawQuarantineEdge`); blocks **85%** of commuter spillover across that edge for **2 weeks**. Max 2 active cordons simultaneously (3 under `rapid_response_corps`). |
| `larvicide` | **Biolarvicide Blitz** / *Larvasida Terpadu* | `1 AP` | Click any district | Cuts district baseline `EpiRuntime` growth multiplier by **35%** for **2 weeks** and clears adjacent river-pool threat. (`biocontrol_taskforce` extends duration to **3 weeks**). |
| `ovitrap_net` | **Ovitrap Grid** / *Jaring Ovitrap* | `1 AP` | Click any district | Installs persistent trap array (**-22% cases/week** for **3 weeks**, stacks once with `larvicide` up to **50%** cap). |
| `ward_triage` | **Emergency Ward Surge** / *Ekspansi IGD* | `1 AP` | Click any district (or global button) | Adds **+85** regional bed surge capacity for **2 weeks** and discharges **-24** active fever load immediately (`+110` surge & `-30` load under `rapid_response_corps`). |
| `mass_fog` | **Sector Fogging** / *Fogging Massal* | `2 AP` | Target district + weakens 1 chosen `nb` neighbor | Slashes current-week active outbreak cases by **55%** in primary district and **25%** in connected neighbor. Cooldown: 2 weeks (no cooldown cost under emergency override, `-150` Eco score bonus penalty). |
| `deep_intel` | **Deep Surveillance** / *Surveilans Aktif* | `0 AP` (2 charges/run; `3` for Surveillance) | Target district | Reveals exact deterministic event/climate modifier for the *next 2 weeks* on that district and grants **+15% mitigation accuracy** bonus (`-15%` variance spikes) there. |

---

## 3. Map Border Hit-Testing & Inter-District Adjacency Graph

`CrisisBoardMode` introduces interactive **border clicking** between neighboring `nb` districts:
- Using the exact adjacency pairs in `DISTRICT_DEFS`:
  - `boyolali <-> [surakarta, klaten, sleman, sukoharjo]`
  - `surakarta <-> [boyolali, klaten, sukoharjo]`
  - `sleman <-> [boyolali, klaten, gunungkidul]`
  - `klaten <-> [boyolali, surakarta, sleman, sukoharjo, gunungkidul]`
  - `sukoharjo <-> [boyolali, surakarta, klaten, gunungkidul]`
  - `gunungkidul <-> [sleman, klaten, sukoharjo]`
- Precompute midpoint coordinates & tangent angles for each valid undirected edge pair `(a, b)` once on init inside `crisis-board.js` (or exported helper in `epi-engine.js`) so:
  1. `CrisisBoardMode` draws glowing **Spillover Arcs** and clickable **Border Lock Nodes** right on each shared frontier.
  2. Clicking within `22px` of a frontier node cleanly toggles `cordon` placement without mis-selecting the district polygon.

---

## 4. Win/Loss Conditions, Weekly Events & Scoring

- **Win Condition:** Complete **Week 8/8** with `G.hospitalLoad <= G.hospitalCap` AND no district in uncontained collapse (`districtLoad < 3x endemicThreshold`).
- **Loss Condition:** `G.hospitalLoad > G.hospitalCap` at the end of any weekly resolution (triggers `gameOver('hospital')` with clean strategy debrief).
- **12 Weekly Event Cards (Selected Seed-Deterministically):**
  - *Monsoon Cloudburst*, *School Term Opening*, *Bengawan Silting*, *Bio-Control Shipment* (`+1 AP` bonus), *Regional Ambulance Convoy*, *Undiagnosed Mild Cluster*, *Cross-Regency Market Fair*, *Volunteer 3M Surge*, *Ward Power Outage*, *Drought Stagnation Pools*, *Rapid Test Kit Drop*, *Early Cold Front Recovery*.
- **Mode 2 Score Calculation:**
  - `(Total Spillover Blocked * 160) + (Remaining ICU Headroom * 20) + (Unspent Charges * 150) + (Clean Containment Weeks * 500) + (Eco Clean Bonus if <=1 Mass Fog used: +600)` multiplied by `(1 + Mutator Bonus)`.
- **Leaderboard Mode Key:** `'crisis_board'`.
