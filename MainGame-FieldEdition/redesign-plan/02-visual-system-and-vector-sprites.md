# 02 — Visual System, Command-Center Layout & Custom Vector Sprites

> **Design Objective:** Eliminate the "generic dark-mode developer prototype + emoji" look from `MainGame/index.html` (which relies on `#111112` iOS-like gray cards, `#0171E3` consumer blue, cluttered top overlays, and 30+ system emojis). Replace it with an atmospheric **Tactical Cartographic Command Center** inspired by modern regional crisis-ops interfaces (*Plague Inc.* clinical clarity + *Into the Breach* tactical legibility).

---

## 1. Visual Design Tokens (`MainGame/site/css/tokens.css`)

```css
:root {
  /* Surface Hierarchy — Deep Cartographic Slate-Teal (replaces #111112 / #1F1F22) */
  --bg-body:        #0B1519;
  --bg-surface:     #132229;
  --bg-elevated:    #1A2E38;
  --bg-glass:       rgba(11, 21, 25, 0.86);
  --bg-scrim:       rgba(6, 12, 15, 0.78);

  /* Crisp Blueprint Borders */
  --border-subtle:  rgba(148, 210, 230, 0.14);
  --border-strong:  #2E4D5B;
  --border-focus:   #38BDF8;

  /* Typography Ink */
  --text-primary:   #E6F0F2;
  --text-secondary: #8FA8B2;
  --text-muted:     #5B737E;

  /* Semantic Action & Domain Accents */
  --accent-primary: #F59E0B;  /* Field Command Amber — primary CTAs */
  --on-accent:      #0A1317;  /* Dark slate ink on Amber */
  --accent-hydro:   #38BDF8;  /* Hydro-Sensor Cyan — rainfall, river corridors, intel */
  --accent-bio:     #2DD4BF;  /* Bio-Control Teal — Wolbachia / PSN ecological layers */

  /* Epidemiological Threat Ramp */
  --status-safe:     #10B981;
  --status-warn:     #F59E0B;
  --status-danger:   #EF4444;
  --status-critical: #D946EF;

  /* Typography Families (self-sufficient system/clean geometric fallback stacks) */
  --font-display: 'Space Grotesk', 'Bahnschrift', 'Segoe UI', system-ui, sans-serif;
  --font-sans:    'Plus Jakarta Sans', 'Inter', 'Segoe UI', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', 'Cascadia Mono', 'Consolas', monospace;

  /* Radii & Shadows */
  --radius-sm:  4px;
  --radius-md:  8px;
  --radius-lg:  12px;
  --radius-pill: 999px;
  --shadow-panel: 0 12px 32px rgba(0, 0, 0, 0.45);
  --glow-amber:   0 0 18px rgba(245, 158, 11, 0.25);

  /* Z-Index Layers */
  --z-canvas:  1;
  --z-hud:     20;
  --z-drawer:  30;
  --z-modal:   50;
  --z-toast:   70;
}
```

### Typography Rules
1. **All numeric KPIs** (Case count, Bed load `42/240`, Funds `$18M` / `Rp 18M` or `18 PTS`, Forecast Interval `14–31`, Combo Multiplier `x2.4`, Timer `02:14`) MUST use `font-family: var(--font-mono); font-variant-numeric: tabular-nums;`.
2. **Upper-case micro-labels** (district tags, classification stamps, radar bearings) use `0.70rem–0.75rem`, `letter-spacing: 0.08em`, `--text-secondary`.
3. Optional Google Fonts `<link>` may enhance `Space Grotesk` / `JetBrains Mono` when online, **but the fallback stack (`Bahnschrift` / `Segoe UI` / `Cascadia Mono`) MUST look crisp offline with zero layout shift**.

---

## 2. Layout Architecture (`MainGame/site/css/layout.css` & `components.css`)

Fix the cramped 2-box HUD and intrusive bottom panel from the screenshot (`final_step_32.png`):

### Desktop (`>= 900px`)
- **Canvas Stage (`100vw x 100vh`)**: The Solo–Yogya Corridor map occupies **100% of the viewport background** with subtle `40px` tactical coordinate grid lines (`rgba(56, 189, 248, 0.04)`) and vignette edges.
- **Floating Top Telemetry Strip (`#hud`, max-height `56px`)**: Three compact translucent (`backdrop-filter: blur(10px)`) clusters:
  - **Left**: Mode badge + Scenario/Month/Week pill + Seed tag.
  - **Center**: Core vitals (Hospital Surge Gauge bar with exact numbers, Operations Budget / Action Points, Combo/Containment Integrity).
  - **Right**: Language switcher (`EN` / `ID`), Audio toggle, Haptics toggle (when supported), **`EpiKD Lab`** button, Pause/Menu button.
- **Collapsible Tactical Operations Rail (`#panel`, `340px` fixed width, docked right with `12px` inset)**:
  - During **Planning / Crisis Board**: Houses selected district telemetry, Threat Meter, Protocol/Action allocation toggles, Shock Intel feed, and `[ COMMIT DEPLOYMENT ]` CTA.
  - During **Active Action Waves (Mode 1 Wave & Mode 3 Blitz)**: Automatically collapses to a slim bottom-center **Field Gadget Dock** (Swat Blade active indicator, Containment Spray charge ring, Quick-Deploy Ward Surge button) so **85%+ of the screen is unobstructed for cursor/finger swatting**.
  - On narrow/short viewports (`< 900px`), the Operations Rail becomes a sleek bottom sheet with a drag/tap handle (`Inspect District` <-> `Collapse to Map`) so the map stays visible above it.

---

## 3. Strict Zero-Emoji Policy & Legacy Emoji Audit Matrix

Every single system emoji present in `MainGame/index.html` MUST be eliminated and replaced with either a crisp **inline `<svg>` icon** (`iconSvg(id, className)` exported by `js/sprites.js`) or a **Canvas 2D vector routine** (`draw*` exported by `js/sprites.js`).

| Legacy Emoji (`MainGame/index.html`) | Legacy Meaning / Context | Target Replacement Vector ID (`sprites.js`) |
| :--- | :--- | :--- |
| `🦟` | Mosquito vector / Blitz / Wave count / Infestation | `vec-mosquito` (SVG icon) + `drawMosquitoSprite()` (Canvas) |
| `🧹` | PSN Clean-up / Standing Water Drain | `vec-broom-psn` (larval brush & water droplet slash) |
| `🪤` | Lethal Ovitrap / Bait Trap | `vec-ovitrap` (hexagonal trap canister with attractant ring) |
| `💨` | Thermal ULV Fogging / Spray Mist | `vec-fogger` (pressurized nozzle + dispersal cone) |
| `🏥` | Field Clinic / Hospital ICU Bed Capacity | `vec-clinic-cross` (emerald/amber triage ward emblem) |
| `🌋` | Merapi Highland Terrain / Scenario hazard | `vec-volcano-peak` (contour peak + ash plume arc) |
| `👑` | Surakarta Core / High Command Rank | `vec-command-chevron` (three-star / diamond command emblem) |
| `🧬` | EpiKD Engine / Model DNA / Genetic Vector | `vec-epi-helix` (clinical sine-node network icon) |
| `🩸` | Fever Bite / Case Spike / Hemorrhagic Threat | `vec-blood-drop` (high-contrast clinical alert droplet) |
| `🏆` | Leaderboard / Victory / Trophy | `vec-trophy-shield` (tactical laurel crest) |
| `🌐` | Language Toggle (`EN` / `ID`) | `vec-globe-grid` (clean latitude/longitude globe) |
| `🔊` / `🔇` | Audio Active / Muted | `vec-audio-on` / `vec-audio-off` (waveform & muted slash) |
| `🌧️` | Monsoon Rain Spike shock / Rainfall Index | `vec-monsoon-cloud` (storm cell + slanting rain vectors) |
| `📋` | Reporting Lag / Case Dossier / Audit | `vec-clipboard-dossier` (tactical briefing pad) |
| `🚆` | Transit Cluster / Commuter Corridor | `vec-rail-transit` (locomotive front + track lines) |
| `📉` | Forecast Revision Down | `vec-trend-down` (segmented Sparkline downward arrow) |
| `🌱` | Larvae Bloom / Community Drain | `vec-larvae-sprout` (aquatic larva / stagnation ring) |
| `⚡` | Surge / Blitz Mode / Quick Strike | `vec-blitz-bolt` (sharp angled voltage bolt) |
| `💧` | Standing Water Pool / Hydration / Drain | `vec-pool-droplet` (rippling pond contour) |
| `🛡️` | Shield / Quarantine Lock / Defense | `vec-defense-shield` (chamfered tactical shield) |
| `🔥` | Streak / Thermal / High Outbreak Heat | `vec-thermal-flame` (geometric flare icon) |
| `✨` | Clean / Critical Perfect / Perk Unlock | `vec-spark-star` (4-point precision reticle star) |
| `💰` | Budget / Operations Funds | `vec-fund-coin` (hexagonal ledger token) |
| `🙋` | Community Kader / Volunteer | `vec-kader-unit` (helmeted field responder silhouette) |
| `🏸` | Swat Action / Mosquito Interception | `vec-swat-arc` (motion-blur blade arc) |
| `🧪` | EpiKD Lab / Surveillance / Bio-Assay | `vec-lab-flask` (graduated surveillance vial) |
| `🏛️` | Municipal Command / Regency Hall | `vec-civic-hall` (pillared district HQ) |
| `🏨` | Ward Extension / Emergency Tents | `vec-ward-tent` (medical annex silhouette) |
| `📣` | Public Advisory / Broadcast | `vec-comms-radar` (directional signal cone) |
| `🧴` | Spray Bomb / Chemical Barrier | `vec-spray-canister` (pressurized canister + AoE ring) |
| `📡` | Surveillance Ping / Radar Sweep | `vec-radar-dish` (animated concentric ping arc) |
| `⭐` | Rank / Mastery Star | `vec-rank-star` (crisp 5-point tactical star) |
| `📜` | Dispatch Decree / Field Manual | `vec-scroll-manual` (classified dossier folder) |

*(Build Guardrail: Include an automated grep assertion in tests or QA verifying **zero Unicode emoji ranges** `[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]` inside `MainGame/site/index.html`, `MainGame/site/js/**/*.js`, and `MainGame/site/css/**/*.css`.)*

---

## 4. Canvas 2D Procedural Map & Entity Upgrades (`js/sprites.js` & `js/map-renderer.js`)

Upgrade the map canvas from flat polygons into a rich **topographic tactical map**:

1. **Background & Relief (`drawMapBackground`, `drawMerapiContour`)**:
   - Subtle UTM-style grid lines (`1px`, `#38BDF8` at `4%` opacity) with faint alphanumeric sector ticks (`A1–D4`) along the margin.
   - Multi-ring topographic contour lines around **Mount Merapi** (NW corridor between Boyolali, Sleman, and Klaten) plus elevation hatch marks around **Gunungkidul karst ridges** in the south.
2. **Hydro-Corridor Rivers (`drawRiverCurves`)**:
   - Render `RIVERS` (Bengawan Solo & Opak/Progo tributaries) as dual-stroke luminous cyan paths (`rgba(56, 189, 248, 0.28)` outer glow + crisp `1.5px` inner spline) with subtle animated flow-dash ticks (`lineDashOffset` advancing with time) to visually anchor why standing water breeds vectors near riverbanks.
3. **District Polygons & Threat Borders (`drawDistrictPolygon`)**:
   - Clean choropleth fill tinted by predicted risk / active infestation density (`SAFE` emerald -> `CRITICAL` magenta-red).
   - **Selected district** receives an animated dashed tactical lock border (`#F59E0B`) + corner brackets.
   - **Quarantine Edge (`drawQuarantineEdge`)**: Used in Mode 2 (and border lockdowns) — renders high-contrast hazard chevron dashes along the shared adjacency boundary between two districts.
4. **Protocol & Unit Markers on Map (`drawUnitMarker`, `drawHotspotNode`)**:
   - Instead of tiny colored dots or text tags, draw clean geometric vector tokens anchored around each district's centroid (`c`):
     - `PSN` -> Teal octagonal ring with clean sweep badge
     - `Traps` -> Amber hexagonal canister with pulsing capture dot
     - `Fog` -> Expanding translucent smoke plume ring
     - `Clinic` -> Crisp emerald square with white medical cross
   - **Standing Water Breeding Pools (Mode 1 & Mode 3)**: Organic dual-ring irregular ellipses with subtle concentric ripple rings (`sin(t)`) and a crisp fill gauge indicating drain progress (`0% -> 100%`) when sliced by the player's cursor/finger.
5. **Articulated Vector Mosquitoes (`drawMosquitoSprite`)**:
   Replace static triangle/dot mosquitoes with distinct silhouettes readable at 60 FPS across 4 archetypes:
   - **Standard *Aedes aegypti***: Striped dark/white abdomen, swept translucent fluttering wings (`sin(t * 28)`), visible proboscis, threat halo when approaching target center.
   - **Aedes Albopictus / Monsoon Feeder (Fast Flanker)**: Elongated cyan-tinted wings, sharper chevron silhouette, speed trail.
   - **Egg-Bearer / Brood Queen (Heavy Vector)**: Larger glowing amber/magenta abdomen sac (`2–3 HP` or splits into 2 larvae pools if left to bite).
   - **Day-Biting Viremic Vector (Blitz / High Risk)**: Crimson core pulse, urgent target reticle lock around nearby clinic/residence node.
6. **Blade Slash & Containment Spray (`drawSlashTrail`, `drawEffectsLayer`)**:
   - Pointer swat draws a tapering **cyan-to-white plasma/radar sweep arc** (`8–12` trail points fading smoothly over `180ms`) rather than raw jagged Canvas lines.
   - Containment Spray (`triggerSprayBomb` / Right-Click / `[SPACE]`) renders an expanding shockwave ring + particulate mist burst with instant hit markers (`+10`, `PURGED`, `CLEARED`).
