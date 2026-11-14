# 04 — Mode 1: Monsoon Operations (Hybrid Tactical + Action Campaign)

> **Target Session Length:** 6–10 minutes (`4` months standard, `6` months Full Monsoon, or scenario presets)  
> **Core Fantasy:** *Regional Satgas DBD Commander* combining pre-wave budget/intelligence planning across 6 Central Java/DIY regencies with frantic direct vector interception when the monsoon rains hit.  
> **Legacy Evolution:** Refines and elevates the core loop of `MainGame/index.html` while fixing its worst friction points (slow passive downtime, cryptic shocks, weak mid-wave agency, cramped HUD).

---

## 1. Command Hub Entry & Scenario Selection (`SCENARIOS`)

Before launching Mode 1, the player picks:
1. **Commander Doctrine** (`surveillance_directorate` | `biocontrol_taskforce` | `rapid_response_corps` — see `01` §4).
2. **Operational Scenario** (4 selectable regional crises, or Custom Seed + Mutators):

| Scenario ID | Title (EN / ID) | Length | Twist & `EpiRuntime` Climate Overlay |
| :--- | :--- | :--- | :--- |
| `solo_basin` | **Standard Monsoon** / *Musim Hujan Standar* | 6 Months (`NOV–APR`) | Canonical 6-regency campaign (`18` starting funds, balanced rainfall curve). Recommended first run & default test scenario. |
| `merapi_ashfall` | **Merapi Perimeter Surge** / *Siaga Lereng Merapi* | 4 Months (`DEC–MAR`) | Highland spillover (`boyolali`, `sleman`, `klaten` receive `+25%` climate pressure; ashfall increases `reporting_lag` probability). Starts with `20` funds. |
| `bengawan_flood` | **Bengawan Floodplain** / *Banjir Bengawan Solo* | 5 Months (`DEC–APR`) | Heavy riparian breeding along `surakarta`, `sukoharjo`, `klaten`; `2x` standing water pools spawn during waves, boosting drain combo rewards. |
| `commuter_corridor` | **Solo–Yogya Rail Corridor** / *Koridor Komuter Solo–Yogya* | 4 Months (`JAN–APR`) | High cross-district mobility (`sleman <-> klaten <-> surakarta` spillover doubled); rewards surveillance sweeps and fast containment placement. |

---

## 2. Upgraded Core Loop & Pacing Fixes

### Phase A: Monthly Command Directive (`BRIEFING` — 10 sec decision)
Replaces dry flavor text (`DISPATCHES`) with **sharp asymmetric dilemmas** tied to real mechanical effects (no hidden disclaimer footnotes):
1. **El Niño Early Rains** -> *Emergency Drain Subsidy* (`+4 Funds`, `-15%` standing water next wave) vs *Reserve ICU Tents* (`+60 Surge Beds` permanently, `-2 Funds`).
2. **Kader Mobilization** -> *Neighborhood 3M Sweep* (`PSN` free in 1 selected district this month) vs *Laboratory Sequencing* (`Surveillance Ping` reveals all 6 districts for 2 months).
3. **Peak Holiday Transit** -> *Station Fever Screening* (`-25%` Sleman/Surakarta commuter spillover) vs *Mobile Clinic Convoy* (`+40 Beds`, `+3 Funds`).
4. **Fogging Chemical Shortage** -> *Prioritize Bio-Ovitraps* (`Traps +20%` effectiveness, `Fog +2` cost for 2 months) vs *Emergency Stockpile Airlift* (`-4 Funds`, `Fog` unlimited & `+1` bonus radius).
5. **Hospital Overload Alert** -> *Divert Regional Wards* (`+120` temporary surge capacity this wave, `-10%` score mult) vs *Strict Community Quarantine* (`-20%` spawn rate, `+1` bite severity if mosquitoes escape).
6. **Late-Monsoon Containment** -> *All-Out Eradication Push* (`+6 Funds`, wave speed `+15%`) vs *Long-Tail Surveillance* (`Reveal` all shocks free, steady recovery `-30` ICU load).

### Phase B: Deployment & Fog-of-War Intel (`PLAN`)
- **Action-First Map Interaction:** Clicking a district polygon directly on the full-screen canvas immediately selects it and opens its radial/side action toggles (`PSN`, `Ovitrap`, `Fog`, `Ward`, `Sweep`).
- **Clear Intel Clarity:**
  - Unrevealed districts show a crisp **predicted median + IQR uncertainty band** (`14–26 cases`) and risk color.
  - Concealed weather/transit anomalies (`shockTemplates`: `rain_spike`, `reporting_lag`, `transit_cluster`, `forecast_revision_down`, `community_drain`, `larvae_bloom`) reveal sequentially at `2.0s` / `4.0s` or immediately via **Surveillance Sweep (`ping`)** (`3` funds base; `2` funds under `surveillance_directorate`).
- **Real-Time Projection Feedback:** Toggling protocols (`PSN`, `Traps`, `Fog`) smoothly animates the district's projected **Mitigation %** gauge and shifts the forecasted vector load before committing.

### Phase C: Active Interception Wave (`WAVE` — 22–28 sec tight tactical-arcade sprint)
Fix the legacy prototype's shallow wave feel by adding **tactile decision-making during the live wave**:
1. **Smooth Progressive Wave Duration (`22–28s`)**: Tighter than slow drag, long enough for tactical decisions.
2. **4 Readable Vector Archetypes** (from `02` §4):
   - *Standard Aedes* (1 HP, steady flight toward clinic/civic center).
   - *Monsoon Flanker* (1 HP, faster lateral weave, spawns along rivers).
   - *Brood Queen* (2 HP or requires clean slash; drops a Breeding Pool if reaching target).
   - *Viremic Vector* (crimson aura; 2x ICU load damage on bite).
3. **Dual Gesture Economy (Mouse & Touch)**:
   - **Precision Slash (`pointerdown` + drag)**: Sweeps across mosquitoes AND drains active **Breeding Pools** (`poolStep` per pass; faster under `biocontrol_taskforce`). Hitting multiple targets in one swipe builds a **Combo Streak (`x1.5`, `x2.0`, `x3.0`)** filling the **Containment Spray Charge (`0–100%`)**.
   - **Targeted Containment Burst (`Right-Click`, `Space`, or HUD Spray Button)**: When charged (`100%`), fires an AoE aerosol dome at cursor/target position, instantly vaporizing mosquitoes in radius (`110px`, `+18%` under `rapid_response_corps`) and sealing nearby pools by `40%`.
4. **Mid-Wave Emergency Triage Call (`Active Ward Reinforce`)**: Players with leftover emergency budget (`>= 3` funds) can click `[ +Surge Ward ]` mid-wave to dump `$3` -> `-25` fever/bed pressure immediately, creating real tension between saving funds vs. buying mid-wave survival.

### Phase D: Post-Wave Triage Report & Field Doctrine Perks (`REPORT` -> `PERK`)
- **Clean Triage Screen (`showReport`)**: Shows regional survival delta (`Beds Freed / Added`, `Cases Prevented`, `Wave Containment Grade S/A/B/C`, `Budget Refill`). **No raw debug strings!** An optional pill **`[ Audit in EpiKD Lab ]`** opens `js/ui/epikd-lab.js` (`openWaveAttributionAudit`) for players who want the mathematical breakdown.
- **Draft 1 of 3 Field Perks (`PERKS`)**: Same balanced 12-perk pool (`js/state.js`), rewritten in clean military/public-health prose (`"24-Hour Kader Shift"`, `"Drone Larvicide"`, `"Pre-Positioned Fogger"`, `"Expanded ICU Annex"`, etc.).

---

## 3. Scoring & Win/Loss Formulas (Mode 1)

- **Loss Condition:** Cumulative regional hospital burden exceeds capacity (`G.hospitalLoad > G.hospitalCap`). Note: legacy `gameOver('hospital')` test hook MUST remain functional so automated E2E tests can still validate loss-state -> leaderboard submission cleanly.
- **Victory Condition:** Survive all months of the chosen Scenario (`4–6` months) with `G.hospitalLoad <= G.hospitalCap`.
- **Mode 1 Score Calculation:**
  - `(Total Cases Prevented * 120) + (Swatted Vectors * 25) + (Pools Drained * 90) + (Peak Unused Bed Headroom * 15) + (Clean Months * 400)` multiplied by `(1 + Mutator Bonus)` and `Scenario Length Factor` (`6m = 1.0x`, `4m = 0.85x` balanced on leaderboard or scenario-tagged).
- **Leaderboard Mode Key:** `'operations'`.
