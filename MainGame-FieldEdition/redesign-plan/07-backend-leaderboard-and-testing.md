# 07 — Backend Per-Mode Leaderboards, Schema Migration & Automated QA Suite

> **Core Infrastructure:** Keeps compatibility with the existing Cloudflare D1 + Worker deployment (`MainGame/worker/wrangler.toml`, `MainGame/wrangler.jsonc`, `dengue.datajoget.my.id`, `dengue-api.datajoget.my.id`), while isolating high scores cleanly per game mode (`operations`, `crisis_board`, `blitz`) and upgrading tests from the old single-file equality check to multi-file modular verification.

---

## 1. D1 / SQLite Schema Upgrade (`MainGame/worker/schema.sql`)

Update `MainGame/worker/schema.sql` to store per-mode, doctrine, and scenario metadata while keeping backward compatibility for existing rows via `DEFAULT 'operations'`:

```sql
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'operations',
  doctrine TEXT DEFAULT '',
  scenario TEXT DEFAULT '',
  seed TEXT DEFAULT '',
  mutators TEXT DEFAULT '',
  months INTEGER DEFAULT 0,
  ip TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scores_mode_score
  ON scores (mode, score DESC, created_at ASC);
```

### Existing Production D1 Migration Note
Document clearly in `README.md` / `schema.sql` comments the one-time `ALTER TABLE` commands for already-provisioned remote D1 databases (`database_name = "dengue-lb"`):
```sql
ALTER TABLE scores ADD COLUMN mode TEXT NOT NULL DEFAULT 'operations';
ALTER TABLE scores ADD COLUMN doctrine TEXT DEFAULT '';
ALTER TABLE scores ADD COLUMN scenario TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_scores_mode_score ON scores (mode, score DESC, created_at ASC);
```
And ensure `MainGame/dev-server.mjs` initializes its local `:memory:` `DatabaseSync` directly from `MainGame/worker/schema.sql` so local testing matches production Worker SQL identically.

---

## 2. Cloudflare Worker API Upgrade (`MainGame/worker/src/index.js`)

Preserve existing CORS headers, IP extraction, score bounds (`1` to `10,000,000`), and response payloads, extending both endpoints for multi-mode filtering:

### Validation Rules
- `ALLOWED_MODES = new Set(['operations', 'crisis_board', 'blitz'])`.
- If `mode` is omitted or empty in `GET /api/top` or `POST /api/submit`, default safely to `'operations'` (ensures zero breakage for legacy clients or direct API curl smoke checks).
- If `mode` is explicitly provided and **not** in `ALLOWED_MODES`, return `400 Bad Request` (`{ error: 'Invalid mode' }`).
- Sanitize `doctrine` (max 32 chars, trimmed) and `scenario` (max 32 chars, trimmed).

### Endpoint Behavior
1. **`GET /api/top?mode=<mode>&limit=<n>`**
   - Clamps `limit` between `1` and `50` (default `20`).
   - Queries:
     ```sql
     SELECT id, name, score, mode, doctrine, scenario, seed, mutators, months, created_at
     FROM scores
     WHERE mode = ?1
     ORDER BY score DESC, created_at ASC
     LIMIT ?2
     ```
   - Returns `{ mode, entries: [...] }` (keep top-level array or key aligned cleanly with `js/leaderboard.js`; verify if legacy clients expect `{ top: [...] }` or `{ entries: [...] }`—inspect `worker/src/index.js` lines 1–50 during implementation and preserve the exact existing top-level response key while adding `mode` fields inside each row!).
2. **`POST /api/submit`**
   - Body JSON: `{ name, score, mode?, doctrine?, scenario?, seed?, mutators?, months? }`.
   - Validates `name` (non-empty trimmed, <= 24 chars), `score` (integer `1..10_000_000`), `mode` (`ALLOWED_MODES`).
   - Inserts row into `scores`.
   - Computes per-mode rank:
     ```sql
     SELECT COUNT(*) + 1 AS rank
     FROM scores
     WHERE mode = ?1
       AND (score > ?2 OR (score = ?2 AND id < ?3))
     ```
   - Returns `{ ok: true, id, rank, mode }` (`200` / `201`).

---

## 3. Client Leaderboard Module (`MainGame/site/js/leaderboard.js`)

- **Exports:** `{ LB_API, submitScore, fetchTop, shareRun, openLeaderboard, closeLeaderboard }`.
- **Host Detection & `window.LB_API` Compatibility:**
  - Preserve exact host-routing logic checked by `test_leaderboard.py`:
    - `dengue.datajoget.my.id` -> `https://dengue-api.datajoget.my.id`
    - `localhost` / `127.0.0.1` -> same-origin (`""`) so `dev-server.mjs` `/api/*` handles calls directly
    - `.workers.dev` -> `https://dengue-api.datajoget.my.id`
  - Expose `window.LB_API` in `main.js` / `leaderboard.js` so existing hosted-domain Playwright tests continue to assert routing without changes to production domains.
- **Per-Mode Tabs in UI (`openLeaderboard(defaultMode)`):**
  - 3 clean tabs: **Operations (`operations`)**, **Crisis Board (`crisis_board`)**, **Outbreak Blitz (`blitz`)**, showing Doctrine + Scenario badge per row (rendered cleanly with SVG icons, zero emojis).
- **Offline / Error Handling:** Graceful inline banner (`"Leaderboard offline — run saved locally"` / `"Papan skor luring — skor tersimpan lokal"`) matching test assertions when `/api/*` fails or returns non-2xx.

---

## 4. Static Deployment Parity & Test Suite Migration (`MainGame/tests/test_leaderboard.py`)

### Critical Breaking Change to Fix in `tests/test_leaderboard.py`
Currently, `MainGame/tests/test_leaderboard.py` line 61 asserts:
```python
GAME_HTML == (ROOT / "site" / "index.html").read_bytes()
```
Because we are moving from a monolithic `MainGame/index.html` to modular `MainGame/site/` files:
1. Update `tests/test_leaderboard.py` to remove the single-file byte-equality check between `MainGame/index.html` and `MainGame/site/index.html`.
2. Replace it with **Multi-File Integrity & Static Asset Verification**:
   - Assert `MainGame/site/index.html` exists, loads `./css/tokens.css`, `./css/layout.css`, `./css/components.css`, and `<script type="module" src="./js/main.js">`.
   - Verify every local `<link>` / `import ... from './...'` asset inside `MainGame/site/` resolves to an existing file on disk and returns `200 OK` over `dev-server.mjs`.
   - Assert **Zero Console Errors & Zero Pageerrors** on page load and across mode switches.
   - Assert **Zero Emojis** (`re.compile(r'[\U0001F300-\U0001FAFF\u2600-\u27BF]')`) across `MainGame/site/index.html`, `site/css/*.css`, and `site/js/**/*.js`.
   - Assert **Zero Gameplay Disclaimers** (confirm strings like `"not calibrated parameters"` or `"Attribution check:"` never appear inside `#hud`, `#panel`, or `#reportScreen` unless the user explicitly opens `#epikdLabDrawer`).

### Required E2E Playwright Test Cases (`tests/test_leaderboard.py`)
1. **`test_static_site_bundle_and_zero_emoji`**: Verifies `site/` tree completeness, dev-server MIME headers (`application/javascript` on `.js`, `text/css` on `.css`), zero console errors, zero emojis.
2. **`test_mode1_operations_phone_flow_and_leaderboard`** (Mobile viewport `390x844`):
   - Launches Hub -> selects **Mode 1 (`operations`)** + Doctrine -> enters `PLAN` -> starts wave -> verifies `window.G.phase` & `window.W.total` -> simulates loss via `window.gameOver('hospital')` (keep hook exposed on `window` for testability) -> fills `#lbNameInput` -> submits to `POST /api/submit` (`mode: 'operations'`) -> verifies row appears in `GET /api/top?mode=operations`.
3. **`test_mode2_crisis_board_flow_and_api`**:
   - Launches **Mode 2 (`crisis_board`)** -> verifies AP economy (`3 AP`), border cordon or district action toggles, zero swatting canvas requirement -> verifies leaderboard isolation (`mode: 'crisis_board'`).
4. **`test_mode3_blitz_flow_and_api`**:
   - Launches **Mode 3 (`blitz`)** -> verifies `150s` countdown timer running, `#panel` hidden/collapsed, zero planning menus -> verifies leaderboard submission (`mode: 'blitz'`) does not leak into `operations` or `crisis_board` tabs.
5. **`test_worker_validation_and_offline_handling`**:
   - Tests invalid `score` (`0`, `-5`, `99999999`) returns `400`, invalid `mode` returns `400`, omitted `mode` defaults cleanly to `'operations'`, UI displays offline fallback banner on mocked network failure, and `window.LB_API` domain mapping passes (`dengue.datajoget.my.id`, `workers.dev`, `localhost`).
6. **`test_epikd_drawer_isolation`**:
   - Confirms `EpiKD KDA` model card, `NB2` metrics, and waterfall attribution audit open cleanly inside `#epikdLabDrawer` on demand and stay hidden during active wave/blitz gameplay.
