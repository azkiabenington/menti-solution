import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidSessionId } from './parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATIC_ALLOWLIST = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.js', { file: 'index.js', type: 'application/javascript; charset=utf-8' }],
  ['/index.css', { file: 'index.css', type: 'text/css; charset=utf-8' }],
  ['/parser.js', { file: 'parser.js', type: 'application/javascript; charset=utf-8' }],
  ['/config.js', { file: 'config.js', type: 'application/javascript; charset=utf-8' }],
  ['/script.user.js', { file: 'script.user.js', type: 'application/javascript; charset=utf-8' }],
  ['/pics/github-mark.svg', { file: 'pics/github-mark.svg', type: 'image/svg+xml' }],
  ['/pics/github-mark-white.svg', { file: 'pics/github-mark-white.svg', type: 'image/svg+xml' }],
]);

function parseAllowedOrigins(rawOrigins) {
  if (rawOrigins === '*') return '*';
  const items = Array.isArray(rawOrigins)
    ? rawOrigins
    : String(rawOrigins || '*')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
  if (items.length === 0 || items.includes('*')) return '*';
  return new Set(items);
}

function buildCorsHeaders(reqOrigin, allowedSet) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (allowedSet === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (reqOrigin && allowedSet.has(reqOrigin)) {
    headers['Access-Control-Allow-Origin'] = reqOrigin;
    headers.Vary = 'Origin';
  }

  return headers;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

// Serves only allowlisted static assets and proxies Mentimeter slide-deck requests.
export function createServerHandler({
  fetchFn = globalThis.fetch,
  rootDir = __dirname,
  allowedOrigins = '*',
  timeoutMs = 10000,
} = {}) {
  const allowedOriginPolicy = parseAllowedOrigins(allowedOrigins);

  return async function handleRequest(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    const corsHeaders = buildCorsHeaders(req.headers?.origin, allowedOriginPolicy);

    let requestUrl;
    try {
      requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: 'Malformed request URL.' }, corsHeaders);
      return;
    }

    try {
      const pathname = requestUrl.pathname;

      if (pathname === '/health' && method === 'GET') {
        sendJson(res, 200, { ok: true }, corsHeaders);
        return;
      }

      if (pathname === '/api/slide-deck') {
        if (method === 'OPTIONS') {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }

        if (method !== 'GET') {
          sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Use GET.' }, corsHeaders);
          return;
        }

        const rawSessionId = requestUrl.searchParams.get('sessionId') || '';
        if (!isValidSessionId(rawSessionId)) {
          sendJson(
            res,
            400,
            { error: 'INVALID_SESSION_ID', message: 'Invalid or missing Mentimeter session ID.' },
            corsHeaders,
          );
          return;
        }

        const sessionId = rawSessionId.trim();
        const upstreamUrl = `https://api.mentimeter.com/audience/slide-deck/${encodeURIComponent(sessionId)}`;

        try {
          const upstreamRes = await fetchFn(upstreamUrl, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (upstreamRes.status === 404) {
            sendJson(
              res,
              404,
              { error: 'QUIZ_NOT_FOUND', message: 'Mentimeter quiz was not found or is inactive.' },
              corsHeaders,
            );
            return;
          }

          if (!upstreamRes.ok) {
            sendJson(
              res,
              502,
              {
                error: 'UPSTREAM_ERROR',
                message: `Mentimeter API returned HTTP ${upstreamRes.status}.`,
              },
              corsHeaders,
            );
            return;
          }

          const rawBody = await upstreamRes.text();
          let parsedBody;
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            sendJson(
              res,
              502,
              { error: 'UPSTREAM_ERROR', message: 'Mentimeter API returned invalid JSON.' },
              corsHeaders,
            );
            return;
          }

          if (!parsedBody || typeof parsedBody !== 'object') {
            sendJson(
              res,
              502,
              { error: 'UPSTREAM_ERROR', message: 'Unexpected payload shape from Mentimeter API.' },
              corsHeaders,
            );
            return;
          }

          sendJson(res, 200, parsedBody, corsHeaders);
        } catch (error) {
          if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            sendJson(
              res,
              504,
              { error: 'UPSTREAM_TIMEOUT', message: 'Mentimeter API timed out.' },
              corsHeaders,
            );
            return;
          }

          sendJson(
            res,
            502,
            { error: 'UPSTREAM_ERROR', message: 'Failed to contact Mentimeter API.' },
            corsHeaders,
          );
        }
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
        return;
      }

      const staticAsset = STATIC_ALLOWLIST.get(pathname);
      if (!staticAsset) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      try {
        const targetPath = path.resolve(rootDir, staticAsset.file);
        const data = await fs.readFile(targetPath);
        res.writeHead(200, {
          'Content-Type': staticAsset.type,
          'Cache-Control': 'no-cache',
        });
        res.end(method === 'HEAD' ? undefined : data);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      }
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'INTERNAL_ERROR', message: 'Internal server error.' }, corsHeaders);
      }
    }
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
  const allowedOrigins = process.env.ALLOWED_ORIGINS || '*';
  const timeoutMs = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || '10000', 10) || 10000;

  const server = http.createServer(
    createServerHandler({
      rootDir: __dirname,
      allowedOrigins,
      timeoutMs,
    }),
  );

  server.listen(port, host, () => {
    console.log(`Mentimeter Quiz Solutions server listening on http://${host}:${port}`);
  });
}
