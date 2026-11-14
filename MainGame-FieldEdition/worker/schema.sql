-- Dengue Defense — leaderboard schema (Cloudflare D1 / SQLite)
-- Used by:
--   * worker/src/index.js  (production Worker, bound to D1 database "dengue-lb")
--   * dev-server.mjs       (local :memory: DatabaseSync bootstrap for dev/test)
--
-- Keep this file executable end-to-end: `wrangler d1 execute dengue-lb --remote --file worker/schema.sql`
-- is safe to re-run (CREATE ... IF NOT EXISTS) and matches the local dev database exactly.

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

-- ---------------------------------------------------------------------------
-- ONE-TIME MIGRATION for existing remote D1 instances (database_name "dengue-lb")
-- that were provisioned from the legacy schema (no mode/doctrine/scenario).
-- Run ONCE per remote database, e.g.:
--   wrangler d1 execute dengue-lb --remote --command "<statement>"
-- or paste into the Cloudflare D1 console. New columns all carry defaults, so
-- existing rows backfill cleanly as mode = 'operations'.
--
--   ALTER TABLE scores ADD COLUMN mode TEXT NOT NULL DEFAULT 'operations';
--   ALTER TABLE scores ADD COLUMN doctrine TEXT DEFAULT '';
--   ALTER TABLE scores ADD COLUMN scenario TEXT DEFAULT '';
--   CREATE INDEX IF NOT EXISTS idx_scores_mode_score
--     ON scores (mode, score DESC, created_at ASC);
--
-- Optional hygiene after the migration succeeds:
--   DROP INDEX IF EXISTS idx_scores_score;   -- superseded by idx_scores_mode_score
--
-- If a remote database predates the legacy `months` / `ip` / `seed` / `mutators`
-- columns as well, add them before deploying the Worker:
--   ALTER TABLE scores ADD COLUMN seed TEXT DEFAULT '';
--   ALTER TABLE scores ADD COLUMN mutators TEXT DEFAULT '';
--   ALTER TABLE scores ADD COLUMN months INTEGER DEFAULT 0;
--   ALTER TABLE scores ADD COLUMN ip TEXT DEFAULT '';
-- Fresh databases do NOT need any ALTER statements — the CREATE TABLE above is
-- already at the target shape.
-- ---------------------------------------------------------------------------
