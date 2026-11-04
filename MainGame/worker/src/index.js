// Dengue Defense — MainGame leaderboard API (Cloudflare Workers + D1)
// Deploy:  wrangler d1 create dengue-lb  → put the database_id below
//          wrangler d1 execute dengue-lb --remote --file schema.sql
//          wrangler deploy
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
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        const { results } = await env.DB.prepare(
          'SELECT name, score, seed, mutators, months, created_at FROM scores ORDER BY score DESC, created_at ASC LIMIT ?1'
        ).bind(limit).all();
        return Response.json({ rows: results }, { headers: cors });
      }

      if (url.pathname === '/api/submit' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return Response.json({ error: 'bad json' }, { status: 400, headers: cors });
        const name = String(body.name || '').trim().slice(0, 24);
        const score = Math.floor(Number(body.score) || 0);
        if (!name || score <= 0 || score > 10_000_000) {
          return Response.json({ error: 'invalid name or score' }, { status: 400, headers: cors });
        }
        const seed = String(body.seed || '').slice(0, 40);
        const mutators = Array.isArray(body.mutators) ? body.mutators.join(',').slice(0, 120) : '';
        const months = Math.min(6, Math.max(0, Math.floor(Number(body.months) || 0)));
        const ip = request.headers.get('CF-Connecting-IP') || '';
        await env.DB.prepare(
          'INSERT INTO scores (name, score, seed, mutators, months, ip) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
        ).bind(name, score, seed, mutators, months, ip).run();
        const row = await env.DB.prepare(
          'SELECT COUNT(*) + 1 AS rank FROM scores WHERE score > ?1'
        ).bind(score).first();
        return Response.json({ ok: true, rank: row.rank }, { headers: cors });
      }

      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      return Response.json({ error: 'server error' }, { status: 500, headers: cors });
    }
  },
};
