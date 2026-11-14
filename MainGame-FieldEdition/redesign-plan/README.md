# Dengue Defense — Field Edition: Commercial Redesign & Multi-Agent Build Plan

> **Target Workspace:** `MainGame/` (`MainGame/site/`, `MainGame/worker/`, `MainGame/dev-server.mjs`, `MainGame/tests/`)  
> **Source Baseline:** `MainGame/index.html` (4,480-line legacy single-file prototype)  
> **Approved Product Scope:** Modes 1–3 (*Monsoon Operations*, *Crisis Board*, *Outbreak Blitz*), Diegetic *Satgas DBD* Command Copy, Optional *EpiKD Lab & Field Manual* Drawer, Zero-Emoji Vector UI, Multi-File ES Module Architecture (`MainGame/site/`).

---

## 1. Index of Specification Documents

| Order | File | Scope & Responsibilities |
| :---: | :--- | :--- |
| `01` | [`01-core-architecture-and-epi-engine.md`](./01-core-architecture-and-epi-engine.md) | Modular `MainGame/site/` tree, ES module exports, verbatim extraction of `MODEL_DATA` (line 645) & `EpiRuntime` (lines 646–860), Commander Doctrines, `window.G`/`window.W` sync, and multi-file `dev-server.mjs` upgrade. |
| `02` | [`02-visual-system-and-vector-sprites.md`](./02-visual-system-and-vector-sprites.md) | Cartographic slate-teal palette (`tokens.css`), desktop/mobile command-center layout (`layout.css`, `components.css`), complete 34-entry zero-emoji audit matrix -> custom SVG & Canvas 2D sprites (`sprites.js`, `map-renderer.js`). |
| `03` | [`03-copywriting-i18n-and-epikd-drawer.md`](./03-copywriting-i18n-and-epikd-drawer.md) | Anti-"vibe-code" rewrite rules, complete EN/ID I18N parity (`i18n.js`), isolation of scientific disclaimers & waterfall math into `#epikdLabDrawer` (`ui/epikd-lab.js`). |
| `04` | [`04-mode1-monsoon-operations.md`](./04-mode1-monsoon-operations.md) | **Mode 1 (`operations`)**: 4–6 month hybrid tactical/arcade campaign, 4 regional scenarios, asymmetric directives, 4 vector archetypes, Containment Spray burst, mid-wave ward surge. |
| `05` | [`05-mode2-crisis-board-strategy.md`](./05-mode2-crisis-board-strategy.md) | **Mode 2 (`crisis_board`)**: 8-week pure turn-based strategy & puzzle, 3 AP economy, shared-border Quarantine Cordon hit-testing, weekly events, zero reflex swatting. |
| `06` | [`06-mode3-outbreak-blitz-arcade.md`](./06-mode3-outbreak-blitz-arcade.md) | **Mode 3 (`blitz`)**: Continuous 150s (`02:30`) arcade survival, combo decay & escalation curve, 3 map drop crates, hidden tactical rail, instant seed replay. |
| `07` | [`07-backend-leaderboard-and-testing.md`](./07-backend-leaderboard-and-testing.md) | `worker/schema.sql` & `worker/src/index.js` per-mode migration (`operations`, `crisis_board`, `blitz`), `leaderboard.js`, and replacement of single-file checks in `tests/test_leaderboard.py` with full E2E & zero-emoji Playwright verification. |
| `Py` | [`orchestrate_build.py`](./orchestrate_build.py) | Ready-to-run `run_workflow` Python script implementing the 4-wave parallel build & verification DAG below. |

---

## 2. Parallel Build DAG & Strict File-Ownership Matrix

To avoid merge conflicts when running parallel worker agents, **every agent owns a strictly disjoint set of files**:

```text
Wave 1 (Parallel Foundation)
  ├── W1-A [Engine & State]   ──> site/js/epi-data.js, site/js/epi-engine.js, site/js/state.js
  ├── W1-B [Visuals & Map]    ──> site/css/tokens.css, site/css/layout.css, site/css/components.css,
  │                               site/js/sprites.js, site/js/map-renderer.js
  ├── W1-C [Audio & I18N]     ──> site/js/audio.js, site/js/i18n.js
  └── W1-D [Backend & API]    ──> dev-server.mjs, worker/schema.sql, worker/src/index.js,
                                  site/js/leaderboard.js
          │
          ▼ (All Wave 1 modules exported & ready)
Wave 2 (Parallel Game Modes)
  ├── W2-A [Mode 1 Ops]       ──> site/js/modes/operations.js
  ├── W2-B [Mode 2 Board]     ──> site/js/modes/crisis-board.js
  └── W2-C [Mode 3 Blitz]     ──> site/js/modes/blitz.js
          │
          ▼ (All 3 Mode Adapters export init/dispose/update/render/onPointer*/onKeyDown/getHudSnapshot)
Wave 3 (Parallel Shell & UI)
  ├── W3-A [Shell & Router]   ──> site/index.html, site/js/main.js
  ├── W3-B [HUD & Modals]     ──> site/js/ui/hud.js, site/js/ui/modals.js
  └── W3-C [EpiKD Drawer]     ──> site/js/ui/epikd-lab.js
          │
          ▼ (Integrated App Served on dev-server.mjs)
Wave 4 (QA & E2E Verification)
  └── W4   [QA & Playwright]  ──> tests/test_leaderboard.py (+ bugfixes verified against live server)
```

### Canonical DOM ID Contract Between `W3-A`, `W3-B`, `W3-C`, and `W4`
All Wave 3 agents MUST honor these exact element IDs inside `MainGame/site/index.html`:
- `#canvas` (full-bleed interactive tactical map), `#hud` (top telemetry bar), `#panel` (collapsible right/bottom tactical rail)
- `#hubScreen` (Mode 1/2/3 Command Hub & Doctrine selector), `#dispatchScreen`, `#reportScreen`, `#perkScreen`, `#pauseScreen`, `#badgeScreen`, `#leaderboardScreen`, `#endScreen`
- `#epikdLabDrawer` (optional slide-over drawer for Model Card / Drivers / Waterfall Audit / Field Manual)
- `#lbNameInput`, `#lbSubmitBtn`, `#lbStatusMsg`, `#lbModeTabs`, `#lbRows` (required by `tests/test_leaderboard.py`)
- Global hooks preserved on `window` by `js/state.js`, `js/leaderboard.js`, and `js/main.js`: `window.G`, `window.W`, `window.LB_API`, `window.gameOver`.

---

## 3. Master Handoff Prompt (Copy-Paste to External Orchestrator)

> Paste the block below into any multi-agent orchestrator (Claude Code teams, Codex, Cursor, CrewAI, or Antigravity `/run-workflow MainGame/redesign-plan/orchestrate_build.py`):

```text
Implement the commercial multi-mode redesign of Dengue Defense inside `MainGame/` strictly following the specification folder `MainGame/redesign-plan/`.

Constraints & Standards:
1. Do NOT modify the weights inside `MODEL_DATA`; extract `MainGame/index.html` line 645 verbatim into `MainGame/site/js/epi-data.js` and `EpiRuntime` (lines 646–860) into `MainGame/site/js/epi-engine.js`.
2. Build a clean multi-file ES module site under `MainGame/site/` (`index.html`, `css/`, `js/`). Update `MainGame/dev-server.mjs` so static files under `MainGame/site/` serve with proper MIME types alongside `/api/*`.
3. Enforce ZERO system emojis across all `MainGame/site/` files—use custom SVG (`js/sprites.js`) and Canvas 2D vector drawing instead.
4. Keep active gameplay text 100% diegetic (Satgas DBD tactical command voice). Isolate all scientific disclaimers, NB2 equations, model checkpoint provenance, and sequential waterfall attribution checks exclusively inside `MainGame/site/js/ui/epikd-lab.js` (`#epikdLabDrawer`).
5. Implement all 3 playable modes (`operations`, `crisis_board`, `blitz`), the 3 Commander Doctrines, and per-mode Worker/D1 leaderboard isolation (`worker/schema.sql`, `worker/src/index.js`).
6. Execute in the 4-wave non-overlapping file-ownership DAG documented in `MainGame/redesign-plan/README.md` (or run `MainGame/redesign-plan/orchestrate_build.py`).
7. Finish by updating and running `MainGame/tests/test_leaderboard.py` (including Playwright E2E checks on desktop + 390x844 mobile viewport, zero console errors, zero-emoji regex check, and all 3 modes + `/api/submit` + `/api/top`).
```
