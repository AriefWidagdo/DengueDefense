# 06 — Mode 3: Outbreak Blitz (Continuous 2:30 Arcade Survival)

> **Target Session Length:** Exactly **150 seconds (`02:30`)** (or survival until hospital overload if earlier)  
> **Core Fantasy:** *Emergency Interception Hotline* — **zero planning menus, zero text interruptions, zero pausing modals**. Instant kinetic mouse/touch action across the 6 Central Java regencies, driven by escalating `EpiRuntime` outbreak pulses.  
> **Commercial Value:** High replayability, "one more run" score-attack hook, crisp 15-second onboarding for new players and mobile/touch audiences.

---

## 1. Pacing Curve & Continuous Spawn Architecture (`MainGame/site/js/modes/blitz.js`)

Exports `BlitzMode` adhering to the Mode Adapter Contract (`id: 'blitz'`, `usesRealTimeCanvasLoop: true`, `supportsPause: true`).

### 150-Second Escalation Timeline
No discrete month transitions—instead, the clock counts down continuously from `150.0s` to `0.0s` while dynamic **Surge Alerts** sweep across different Solo–Yogya corridors every `25s`:

| Time Window | Intensity Phase | Spawn & Hazard Behavior |
| :--- | :--- | :--- |
| `02:30 – 01:55` | **Stage 1: First Monsoon Front** | Steady Aedes spawns across 2 focal districts (`surakarta`, `klaten`). Occasional Breeding Pools appear along `RIVERS`. Ideal for building initial `x2.0` combo. |
| `01:55 – 01:15` | **Stage 2: Riverbank Escalation** | **Monsoon Flankers** enter; `2` simultaneous hotspot districts pulse amber; Standing Water Pools accelerate spawn ticks unless drained (`+150` instant pool clear bonus). |
| `01:15 – 00:35` | **Stage 3: Corridor Outbreak** | **Brood Queens (2 HP)** & **Viremic Vectors (2x ICU Damage)** spawn; cross-district commuter waves surge across `sleman <-> klaten <-> surakarta`. Fever recovery slows slightly unless Containment Spray clears cluster. |
| `00:35 – 00:00` | **Stage 4: Red-Alert Climax ("FINAL 30s")** | Sky/grid accent shifts subtly toward high-alert crimson; `1.6x` spawn rate, **2x Score Multiplier**, frequent Golden/Bio-Boost Powerups spawn on the map to create thrilling comebacks! |

### Continuous `EpiRuntime` Seeding (Zero Freeze)
Instead of running synchronous multi-month screens, `BlitzMode.init()` runs `EpiRuntime` across the seed's 6 districts to compute each regency's **Hazard Weight Vector** (`boyolali..gunungkidul`), determining which regencies glow hottest and spawn faster *without* freezing the frame loop.

---

## 2. Arcade Mechanics: Combos, Tactical Drops & Fever Economy

To ensure Mode 3 feels juicy and intentional (never mindless button-mashing):

1. **Precision Combo & Flow Multiplier (`1.0x` -> `5.0x`)**
   - Swatting mosquitoes or finishing a Breeding Pool drain resets a **`2.2s` Combo Decay Timer**.
   - Every **4 consecutive swats** increments combo tier (`1.0x -> 1.5x -> 2.0x -> 3.0x -> 4.0x -> 5.0x MAX`).
   - Letting a mosquito bite an unshielded clinic/city core drops the multiplier by `-1 tier` (not total wipe, preventing unfair tilt) and increases `G.hospitalLoad`.
2. **Containment Spray / Aerosol Shockwave (`triggerSprayBomb`)**
   - Swatting charges the circular **Containment Gauge (`0–100%`)** smoothly (+6% per kill, +15% per drained pool; `+20%` faster under `rapid_response_corps`).
   - Pressing `Space`, `Right-Click`, or tapping the bottom-center **`[ DEPLOY SPRAY ]`** trigger unleashes an expanding mist shockwave at cursor/last tap position, scoring multi-kills at `combo * 1.5x` ("SWARM PURGED!").
3. **Clickable Tactical Map Drops (3 Field Crates)**
   Every `18–22s`, an emergency supply beacon drops onto a threatened district (`24px` pulsing vector icon, vanishes after `7s` if ignored):
   - **`Triage Relief Crate` (`vec-clinic-cross`)**: Instant `-35` ICU bed load recovery + `3s` Hospital Freeze.
   - **`Larvicide Overdrive` (`vec-ovitrap`)**: Instant drains all active Breeding Pools on the map and freezes new pool spawns for `8s`.
   - **`Cryo-Radar Slow` (`vec-radar-dish`)**: Slows all active vectors by `45%` for `5s` (`Bullet Time` cleanup window).
4. **Audio & Tactile Juice Hooks (`js/audio.js`)**
   - `SFX` scales pitch subtly up a pentatonic scale (`C5 -> D5 -> E5 -> G5 -> A5 -> C6`) as Combo rises!
   - Reaching `4.0x+` activates subtle layered bass pulse synced to final 30s urgency.

---

## 3. Minimal Zero-Clutter Blitz HUD

During `BlitzMode`, `#panel` (the right tactical rail) is **completely hidden (`display: none` / collapsed)**:
- Top HUD shows only **4 clean telemetry pills**:
  1. **Countdown Clock** (`02:14.8` in large tabular mono, pulses amber under `30s`).
  2. **Hospital Surge Meter** (`48 / 240 Beds`, fills green -> amber -> red).
  3. **Live Score & Combo Pill** (`14,850` + animated `x3.0 COMBO` progress ring).
  4. **Quick Controls** (`Audio`, `Pause`, `EpiKD Lab` locked/icon-only in Blitz so players don't misclick text).
- Bottom Center shows only the **Containment Spray Trigger (`[SPACE] / TAP`)** meter.

---

## 4. End-of-Run Debrief, Grade & Leaderboard (`'blitz'`)

- Reaching `00:00` with `G.hospitalLoad <= G.hospitalCap` triggers **Blitz Victory** (`+1,500` Survival Clear Bonus + `+25 * unusedBedCapacity`).
- Overloading hospital (`G.hospitalLoad > G.hospitalCap`) ends early via `gameOver('hospital')` cleanly with Partial Score recorded!
- **Performance Grade**:
  - `S` (Zero Bites / Peak Combo >= 4x + Clear)
  - `A` (Cleared with < 60% Peak Bed Load)
  - `B` (Cleared)
  - `C` (Survived >= 90s before overload)
  - `D` (Early collapse)
- **Instant Replay Loop**: End screen offers **1-click `[ PLAY AGAIN (SAME SEED) ]`**, **`[ NEW SEED ]`**, and inline Leaderboard submission (`mode: 'blitz'`).
- **Leaderboard Mode Key:** `'blitz'`.
