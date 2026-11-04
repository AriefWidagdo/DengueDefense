// Local-only game and leaderboard server. Scores stay in memory and are never
// sent to Cloudflare. Requires Node.js 22.5 or newer for node:sqlite.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import leaderboard from './worker/src/index.js';

const port = Number(process.argv[2] || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Provide a port from 1 to 65535.');
}

const game = readFileSync(new URL('./index.html', import.meta.url));
const schema = readFileSync(new URL('./worker/schema.sql', import.meta.url), 'utf8');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(schema);

// Match the D1 methods used by the real leaderboard Worker, backed by the
// same SQL schema. This is a local test database, not the remote D1 database.
const DB = {
  prepare(sql) {
    const statement = sqlite.prepare(sql);
    return {
      bind(...values) {
        return {
          async run() { return statement.run(...values); },
          async all() { return { results: statement.all(...values) }; },
          async first() { return statement.get(...values) || null; },
        };
      },
    };
  },
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(game);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(404).end('Not found');
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const options = { method: req.method, headers: req.headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') options.body = Buffer.concat(chunks);
    const response = await leaderboard.fetch(new Request(url, options), { DB });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Local request failed:', error.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('Local server error');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Game: http://127.0.0.1:${port}`);
  console.log('Leaderboard scores are local only and reset when the server stops.');
});
