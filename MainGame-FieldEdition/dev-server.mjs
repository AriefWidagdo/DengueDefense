// Local-only game and leaderboard server. Scores stay in memory and are never
// sent to Cloudflare. Requires Node.js 22.5 or newer for node:sqlite.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import leaderboard from './worker/src/index.js';

const port = Number(process.argv[2] || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Provide a port from 1 to 65535.');
}

const SITE_ROOT = path.resolve(fileURLToPath(new URL('./site', import.meta.url)));
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

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const options = { method: req.method, headers: req.headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') options.body = Buffer.concat(chunks);
      const response = await leaderboard.fetch(new Request(url, options), { DB });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end('Method not allowed');
      return;
    }

    let cleanPath;
    try {
      cleanPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad request');
      return;
    }

    // Resolve inside SITE_ROOT and refuse anything that escapes it.
    let candidate = path.resolve(SITE_ROOT, '.' + cleanPath);
    if (candidate !== SITE_ROOT && !candidate.startsWith(SITE_ROOT + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return;
    }
    if (candidate === SITE_ROOT) candidate = path.join(SITE_ROOT, 'index.html');

    let body;
    try {
      body = await readFile(candidate);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }

    const type = MIME_TYPES[path.extname(candidate).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
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
