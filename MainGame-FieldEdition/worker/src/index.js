// Dengue Defense — MainGame leaderboard API (Cloudflare Workers + D1)
// Deploy:  wrangler d1 create dengue-lb  → put the database_id below
//          wrangler d1 execute dengue-lb --remote --file schema.sql
//          wrangler deploy
//
// Zero dependencies. Preserves the legacy CORS headers, CF-Connecting-IP
// extraction, and the legacy top-level response key of GET /api/top ("rows"),
// extended with per-mode isolation (operations | crisis_board | blitz).

const ALLOWED_MODES = new Set(['operations', 'crisis_board', 'blitz']);
const DEFAULT_MODE = 'operations';
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const SCORE_MIN = 1;
const SCORE_MAX = 10_000_000;
const NAME_MAX = 24;
const SHORT_FIELD_MAX = 32; // doctrine / scenario
const SEED_MAX = 40;
const MUTATORS_MAX = 120;

// mode omitted/empty -> DEFAULT_MODE; explicitly invalid -> null (caller 400s).
function resolveMode(raw) {
  if (raw == null) return { mode: DEFAULT_MODE };
  const m = String(raw).trim();
  if (!m) return { mode: DEFAULT_MODE };
  if (!ALLOWED_MODES.has(m)) return { mode: null };
  return { mode: m };
}

function sanitizeShort(value, max = SHORT_FIELD_MAX) {
  return String(value ?? '').trim().slice(0, max);
}

function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      if (url.pathname === '/api/top' && request.method === 'GET') {
        const { mode } = resolveMode(url.searchParams.get('mode'));
        if (!mode) return Response.json({ error: 'Invalid mode' }, { status: 400, headers: cors });
        const limit = clampInt(url.searchParams.get('limit'), 1, MAX_LIMIT, DEFAULT_LIMIT);
        const { results } = await env.DB.prepare(
          'SELECT id, name, score, mode, doctrine, scenario, seed, mutators, months, created_at FROM scores WHERE mode = ?1 ORDER BY score DESC, created_at ASC LIMIT ?2'
        ).bind(mode, limit).all();
        // Preserve the legacy top-level key shape ({ rows: [...] }); add mode alongside.
        return Response.json({ rows: results, mode }, { headers: cors });
      }

      if (url.pathname === '/api/submit' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return Response.json({ error: 'bad json' }, { status: 400, headers: cors });

        const { mode } = resolveMode(body.mode);
        if (!mode) return Response.json({ error: 'Invalid mode' }, { status: 400, headers: cors });

        const name = String(body.name ?? '').trim();
        const scoreNum = Number(body.score);
        const score = Number.isFinite(scoreNum) ? Math.floor(scoreNum) : NaN;
        if (!name || name.length > NAME_MAX || !Number.isFinite(score) || score < SCORE_MIN || score > SCORE_MAX) {
          return Response.json({ error: 'invalid name or score' }, { status: 400, headers: cors });
        }

        const doctrine = sanitizeShort(body.doctrine);
        const scenario = sanitizeShort(body.scenario);
        const seed = String(body.seed ?? '').trim().slice(0, SEED_MAX);
        const mutators = Array.isArray(body.mutators)
          ? body.mutators.join(',').slice(0, MUTATORS_MAX)
          : String(body.mutators ?? '').trim().slice(0, MUTATORS_MAX);
        const months = clampInt(body.months, 0, 6, 0);
        const ip = request.headers.get('CF-Connecting-IP') || '';

        const insert = await env.DB.prepare(
          'INSERT INTO scores (name, score, mode, doctrine, scenario, seed, mutators, months, ip) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
        ).bind(name, score, mode, doctrine, scenario, seed, mutators, months, ip).run();

        // node:sqlite returns { lastInsertRowid }; D1 returns { meta: { last_row_id } }.
        const rawId = insert?.meta?.last_row_id ?? insert?.lastInsertRowid ?? null;
        const id = rawId == null ? null : Number(rawId);

        let rank = null;
        if (id != null && Number.isFinite(id)) {
          const row = await env.DB.prepare(
            'SELECT COUNT(*) + 1 AS rank FROM scores WHERE mode = ?1 AND (score > ?2 OR (score = ?2 AND id < ?3))'
          ).bind(mode, score, id).first();
          rank = row?.rank ?? null;
        } else {
          const row = await env.DB.prepare(
            'SELECT COUNT(*) + 1 AS rank FROM scores WHERE mode = ?1 AND score > ?2'
          ).bind(mode, score).first();
          rank = row == null ? null : Number(row.rank);
        }

        return Response.json({ ok: true, id, rank, mode }, { status: 201, headers: cors });
      }

      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      return Response.json({ error: 'server error' }, { status: 500, headers: cors });
    }
  },
};
