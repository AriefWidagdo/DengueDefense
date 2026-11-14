"""
Dynamic Antigravity `run_workflow` script implementing the 4-wave parallel build
of Dengue Defense — Field Edition from `MainGame/redesign-plan/`.

Usage (from a fresh planning/execution session in workspace root):
  /run-workflow Read MainGame/redesign-plan/orchestrate_build.py and execute it via run_workflow.
"""

COMMON_RULES = """
STRICT BUILD RULES:
- Work only inside your assigned file ownership list. Do NOT edit files owned by peer agents in this wave.
- Source legacy baseline for data extraction is `MainGame/index.html`.
- Enforce ZERO system emojis (Unicode U+1F300..U+1FAFF, U+2600..U+27BF) in UI, CSS, or JS strings.
- Enforce ZERO scientific disclaimers or debug checks (e.g. 'Attribution check:') in active gameplay HUD/modals; those belong strictly in `MainGame/site/js/ui/epikd-lab.js`.
- Follow the exact exported symbol names, CSS tokens, and DOM IDs documented in `MainGame/redesign-plan/`.
""".strip()

RESULT_SCHEMA = {
    "type": "object",
    "properties": {
        "agent_id": {"type": "string"},
        "files_written": {"type": "array", "items": {"type": "string"}},
        "exported_symbols": {"type": "array", "items": {"type": "string"}},
        "notes": {"type": "string"},
    },
    "required": ["agent_id", "files_written", "notes"],
}

WAVE_1_TASKS = [
    {
        "id": "W1-A",
        "role": "W1-A Epi Engine and State",
        "owns": [
            "MainGame/site/js/epi-data.js",
            "MainGame/site/js/epi-engine.js",
            "MainGame/site/js/state.js",
        ],
        "specs": [
            "MainGame/redesign-plan/01-core-architecture-and-epi-engine.md",
            "MainGame/redesign-plan/04-mode1-monsoon-operations.md",
            "MainGame/redesign-plan/05-mode2-crisis-board-strategy.md",
            "MainGame/redesign-plan/06-mode3-outbreak-blitz-arcade.md",
        ],
        "instructions": (
            "1. Extract `MODEL_DATA` verbatim from `MainGame/index.html` line 645 into `MainGame/site/js/epi-data.js` as `export const MODEL_DATA`.\n"
            "2. Extract `EpiRuntime`, `DISTRICT_DEFS`, `RIVERS`, `RISK`, `buildDistrict`, `inside`, `computeDistrictDrivers` into `MainGame/site/js/epi-engine.js`, adding `districtAt`, `riskOf`, and optional climate overlay support.\n"
            "3. Build `MainGame/site/js/state.js` exporting `GAME_RULES`, `MONTHS`, `MODES`, `DOCTRINES` (`surveillance_directorate`, `biocontrol_taskforce`, `rapid_response_corps`), `SCENARIOS`, `PROTOCOLS`, `MUTATORS`, `PERKS`, `ACHIEVEMENTS`, `freshState`, `mulberry32`, `parseSeed`, `randomSeedWord`, `scoreMult`, `hasMut`, `getG`/`setG`, `getW`/`setW` (syncing `window.G` and `window.W`)."
        ),
    },
    {
        "id": "W1-B",
        "role": "W1-B Visual System and Sprites",
        "owns": [
            "MainGame/site/css/tokens.css",
            "MainGame/site/css/layout.css",
            "MainGame/site/css/components.css",
            "MainGame/site/js/sprites.js",
            "MainGame/site/js/map-renderer.js",
        ],
        "specs": [
            "MainGame/redesign-plan/02-visual-system-and-vector-sprites.md",
            "MainGame/redesign-plan/README.md",
        ],
        "instructions": (
            "1. Create `tokens.css`, `layout.css`, and `components.css` implementing the cartographic slate-teal command center palette (`#0B1519`, `#132229`, `#F59E0B`, `#38BDF8`), full-bleed map stage, compact 56px top HUD, and collapsible `#panel` rail.\n"
            "2. Build `MainGame/site/js/sprites.js` with every vector SVG icon from the 34-entry audit table (`iconSvg`, `SVG_ICONS`) plus Canvas 2D map, contour, river, hotspot, mosquito archetype, quarantine border, slash arc, and effects renderers.\n"
            "3. Build `MainGame/site/js/map-renderer.js` handling projection (`toScreen`, `toMap`), `resizeCanvas`, particle `FX` (`floatText`, `burst`, `splat`), and `MapRenderer`."
        ),
    },
    {
        "id": "W1-C",
        "role": "W1-C Audio Copy and I18N",
        "owns": [
            "MainGame/site/js/audio.js",
            "MainGame/site/js/i18n.js",
        ],
        "specs": [
            "MainGame/redesign-plan/03-copywriting-i18n-and-epikd-drawer.md",
            "MainGame/redesign-plan/01-core-architecture-and-epi-engine.md",
        ],
        "instructions": (
            "1. Extract WebAudio synthesizer `SFX` (`MainGame/index.html` lines 884-1038) into `MainGame/site/js/audio.js`, enhancing pitch scaling for Mode 3 Blitz combos.\n"
            "2. Build `MainGame/site/js/i18n.js` with 100% key parity between `en` and `id` for Hub, Doctrines, Mode 1/2/3 UI, Perks, Badges, Leaderboard, and optional `epikd.*` drawer strings—strictly zero emojis and zero gameplay disclaimers."
        ),
    },
    {
        "id": "W1-D",
        "role": "W1-D Backend Worker and Dev Server",
        "owns": [
            "MainGame/dev-server.mjs",
            "MainGame/worker/schema.sql",
            "MainGame/worker/src/index.js",
            "MainGame/site/js/leaderboard.js",
        ],
        "specs": [
            "MainGame/redesign-plan/01-core-architecture-and-epi-engine.md",
            "MainGame/redesign-plan/07-backend-leaderboard-and-testing.md",
        ],
        "instructions": (
            "1. Update `MainGame/dev-server.mjs` to safely serve static ES modules/CSS/SVG/HTML from `MainGame/site/` with proper MIME headers and bootstrap `:memory:` SQLite from `worker/schema.sql`.\n"
            "2. Update `MainGame/worker/schema.sql` and `MainGame/worker/src/index.js` to support `mode` (`operations`, `crisis_board`, `blitz` — defaulting omitted `mode` to `'operations'`), `doctrine`, and `scenario` on `/api/top` and `/api/submit`.\n"
            "3. Create `MainGame/site/js/leaderboard.js` preserving `window.LB_API` domain detection and adding 3-mode tabbed leaderboard UI."
        ),
    },
]

WAVE_2_TASKS = [
    {
        "id": "W2-A",
        "role": "W2-A Mode 1 Operations",
        "owns": ["MainGame/site/js/modes/operations.js"],
        "specs": ["MainGame/redesign-plan/04-mode1-monsoon-operations.md"],
        "instructions": (
            "Implement `OperationsMode` adhering to the Mode Adapter Contract in `01` §6 and full mechanics in `04`: "
            "4 scenarios, Doctrine modifiers, asymmetric Directives, concealed fog-of-war shocks, 4 vector archetypes, "
            "slash swatting + pool draining + Containment Spray AoE, mid-wave `+Surge Ward`, and `window.gameOver('hospital')` hook."
        ),
    },
    {
        "id": "W2-B",
        "role": "W2-B Mode 2 Crisis Board",
        "owns": ["MainGame/site/js/modes/crisis-board.js"],
        "specs": ["MainGame/redesign-plan/05-mode2-crisis-board-strategy.md"],
        "instructions": (
            "Implement `CrisisBoardMode` adhering to `01` §6 and `05`: 8-week pure turn-based strategy with zero reflex swatting, "
            "3 AP economy (+1 carryover), interactive shared-border Quarantine Cordon hit-testing, 6 tactical actions with live "
            "spillover dry-run preview, animated 1.5s weekly resolution, and 12 seeded weekly event cards."
        ),
    },
    {
        "id": "W2-C",
        "role": "W2-C Mode 3 Outbreak Blitz",
        "owns": ["MainGame/site/js/modes/blitz.js"],
        "specs": ["MainGame/redesign-plan/06-mode3-outbreak-blitz-arcade.md"],
        "instructions": (
            "Implement `BlitzMode` adhering to `01` §6 and `06`: continuous 150s (`02:30`) real-time survival driven by `EpiRuntime` "
            "district hazard weights, 4 escalation stages, `1.0x–5.0x` combo decay multiplier, Containment Spray burst, 3 clickable "
            "tactical supply crates, hidden right rail (`#panel`), and `S/A/B/C/D` debrief grading."
        ),
    },
]

WAVE_3_TASKS = [
    {
        "id": "W3-A",
        "role": "W3-A HTML Shell and Main Router",
        "owns": ["MainGame/site/index.html", "MainGame/site/js/main.js"],
        "specs": [
            "MainGame/redesign-plan/01-core-architecture-and-epi-engine.md",
            "MainGame/redesign-plan/README.md",
        ],
        "instructions": (
            "Build semantic `MainGame/site/index.html` containing all canonical DOM IDs (`#canvas`, `#hud`, `#panel`, `#hubScreen`, "
            "`#dispatchScreen`, `#reportScreen`, `#perkScreen`, `#pauseScreen`, `#badgeScreen`, `#leaderboardScreen`, `#endScreen`, "
            "`#epikdLabDrawer`, `#lbNameInput`, etc.) and `MainGame/site/js/main.js` wiring RAF loop, pointer/keyboard dispatch, "
            "URL `?seed=` & `?mode=` boot flags, `window.G`/`W`/`LB_API`/`gameOver`, and mode switching."
        ),
    },
    {
        "id": "W3-B",
        "role": "W3-B HUD Hub and Modals",
        "owns": ["MainGame/site/js/ui/hud.js", "MainGame/site/js/ui/modals.js"],
        "specs": [
            "MainGame/redesign-plan/02-visual-system-and-vector-sprites.md",
            "MainGame/redesign-plan/03-copywriting-i18n-and-epikd-drawer.md",
        ],
        "instructions": (
            "Implement mode-aware `hud.js` (top bar, collapsible `#panel`, Mode 3 hidden rail + bottom spray dock, toasts, banners) "
            "and `modals.js` (Command Hub mode/doctrine/scenario picker, Pause, Badges, clean Debrief/End screen with zero emojis "
            "and zero disclaimers)."
        ),
    },
    {
        "id": "W3-C",
        "role": "W3-C EpiKD Lab Drawer",
        "owns": ["MainGame/site/js/ui/epikd-lab.js"],
        "specs": ["MainGame/redesign-plan/03-copywriting-i18n-and-epikd-drawer.md"],
        "instructions": (
            "Implement optional `#epikdLabDrawer` in `MainGame/site/js/ui/epikd-lab.js` (`openEpikdLab`, `closeEpikdLab`, "
            "`openWaveAttributionAudit`) housing all 4 technical tabs: Model Card (`MODEL_DATA.meta` + NB2 scope note), "
            "District Drivers chart, Waterfall Audit accounting ledger, and Field Manual."
        ),
    },
]


def make_prompt(task: dict) -> str:
    owns = "\n".join(f"- `{p}`" for p in task["owns"])
    specs = "\n".join(f"- `{p}`" for p in task["specs"])
    return (
        f"{task['role']}\n\n"
        f"{COMMON_RULES}\n\n"
        f"OWNED FILES (create/edit ONLY these):\n{owns}\n\n"
        f"REQUIRED SPECS TO READ FIRST:\n{specs}\n\n"
        f"DELIVERABLES:\n{task['instructions']}"
    )


phase("Wave 1 — Core Foundation & Backend")
log("Starting Wave 1 (4 parallel workers)...")
w1_results = await parallel(
    WAVE_1_TASKS,
    lambda t: agent(
        prompt=make_prompt(t),
        schema=RESULT_SCHEMA,
        role=t["role"],
        workspace="inherit",
    ),
)
log("Wave 1 complete:", [r["agent_id"] for r in w1_results])

phase("Wave 2 — Mode Implementations (Modes 1-3)")
log("Starting Wave 2 (3 parallel mode workers)...")
w2_results = await parallel(
    WAVE_2_TASKS,
    lambda t: agent(
        prompt=make_prompt(t),
        schema=RESULT_SCHEMA,
        role=t["role"],
        workspace="inherit",
    ),
)
log("Wave 2 complete:", [r["agent_id"] for r in w2_results])

phase("Wave 3 — Shell HTML, HUD, Modals & EpiKD Drawer")
log("Starting Wave 3 (3 parallel UI workers)...")
w3_results = await parallel(
    WAVE_3_TASKS,
    lambda t: agent(
        prompt=make_prompt(t),
        schema=RESULT_SCHEMA,
        role=t["role"],
        workspace="inherit",
    ),
)
log("Wave 3 complete:", [r["agent_id"] for r in w3_results])

phase("Wave 4 — Playwright E2E & Integration Verification")
qa_prompt = f"""
W4 Automated QA and Playwright E2E Verification

{COMMON_RULES}

OWNED FILE TO UPDATE:
- `MainGame/tests/test_leaderboard.py`

REQUIRED SPEC:
- `MainGame/redesign-plan/07-backend-leaderboard-and-testing.md`

TASKS:
1. Update `MainGame/tests/test_leaderboard.py` to remove the monolithic `index.html == site/index.html` check and verify multi-file ES module loading, zero Unicode emojis, zero gameplay disclaimers outside `#epikdLabDrawer`, and E2E flows for Modes 1, 2, and 3 + `/api/submit` + `/api/top` on both desktop and `390x844` mobile viewports.
2. Execute the full test suite (`python -m unittest discover -s MainGame/tests -v` or `pytest MainGame/tests/test_leaderboard.py`).
3. Report exact command output and pass/fail counts. If minor import/DOM mismatches are found, list exact file and line fixes needed.
"""
qa_result = await agent(
    prompt=qa_prompt,
    schema=RESULT_SCHEMA,
    role="W4 QA and Playwright Verifier",
    workspace="inherit",
)
log("Wave 4 QA result:", qa_result)

summary = {
    "wave1": w1_results,
    "wave2": w2_results,
    "wave3": w3_results,
    "wave4_qa": qa_result,
}
print(summary)
summary
