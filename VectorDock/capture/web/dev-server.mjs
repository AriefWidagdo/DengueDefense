/**
 * Local development server for the VectorDock capture page.
 *
 * This is a local-only aid that mirrors the Cloudflare Pages advanced-mode
 * behavior: static assets are served through the same `env.ASSETS.fetch()`
 * seam and `/api/*` requests run through the same `_worker.js` proxy logic.
 * It starts no cloud services; point CAPTURE_BACKEND_ORIGIN at a backend you
 * run yourself (see README.md).
 *
 * Usage:
 *   CAPTURE_BACKEND_ORIGIN=http://127.0.0.1:8765 \
 *   CAPTURE_RELAY_TOKEN=dev-relay-token-0123456789abcdef \
 *   node dev-server.mjs [port]
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./_worker.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2] || 8788);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

async function serveAsset(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname === "") {
    pathname = "/index.html";
  }
  const resolved = normalize(join(ROOT, pathname));
  if (!resolved.startsWith(ROOT)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const data = await readFile(resolved);
    return new Response(data, {
      status: 200,
      headers: { "content-type": CONTENT_TYPES[extname(resolved)] || "application/octet-stream" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

const env = {
  CAPTURE_BACKEND_ORIGIN: process.env.CAPTURE_BACKEND_ORIGIN || "",
  CAPTURE_RELAY_TOKEN: process.env.CAPTURE_RELAY_TOKEN || "",
  CAPTURE_ENVIRONMENT: process.env.CAPTURE_ENVIRONMENT || "development",
  ASSETS: { fetch: serveAsset },
};

const server = createServer(async (req, res) => {
  const origin = `http://127.0.0.1:${PORT}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  const request = new Request(origin + req.url, {
    method: req.method,
    headers: req.headers,
    body,
  });
  const response = await worker.fetch(request, env);
  const headers = {};
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") {
      res.setHeader("set-cookie", response.headers.getSetCookie());
    } else {
      headers[name] = value;
    }
  }
  res.writeHead(response.status, response.statusText, headers);
  if (response.body) {
    res.end(Buffer.from(await response.arrayBuffer()));
  } else {
    res.end();
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`VectorDock capture dev server on http://127.0.0.1:${PORT}`);
  console.log(`Backend origin: ${env.CAPTURE_BACKEND_ORIGIN || "(not configured - API will report 503)"}`);
});
