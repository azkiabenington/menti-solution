import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidSessionId } from './parser.js';
import { runAgySolver, validateSolvePayload } from './solver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_SOLVE_BODY_BYTES = 64 * 1024;

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

function createHttpError(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

async function readJsonBody(req, maxBytes = MAX_SOLVE_BODY_BYTES) {
  const declaredLen = Number.parseInt(req.headers?.['content-length'] || '', 10);
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    throw createHttpError('PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`, 413);
  }

  let totalBytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      throw createHttpError('PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`, 413);
    }
    chunks.push(buf);
  }

  const rawText = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawText) {
    throw createHttpError('INVALID_SOLVE_REQUEST', 'Request body cannot be empty.', 400);
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw createHttpError('INVALID_SOLVE_REQUEST', 'Request body must be valid JSON.', 400);
  }
}

async function resolveParticipationKey(sessionId, fetchFn, timeoutMs) {
  if (!/^\d{6,10}$/.test(sessionId)) {
    return sessionId;
  }

  const lookupUrl = `https://api.mentimeter.com/audience/slide-deck/${encodeURIComponent(sessionId)}/participation-key`;
  const keyRes = await fetchFn(lookupUrl, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (keyRes.status === 404) {
    throw createHttpError('QUIZ_NOT_FOUND', 'Mentimeter quiz was not found or is inactive.', 404);
  }
  if (!keyRes.ok) {
    throw createHttpError('UPSTREAM_ERROR', `Mentimeter API returned HTTP ${keyRes.status}.`, 502);
  }

  const keyPayload = await keyRes.json().catch(() => null);
  const resolved = typeof keyPayload?.participation_key === 'string' ? keyPayload.participation_key.trim() : '';
  if (!isValidSessionId(resolved)) {
    throw createHttpError('QUIZ_NOT_FOUND', 'Mentimeter quiz was not found or is inactive.', 404);
  }

  return resolved;
}

// Serves only allowlisted static assets and proxies Mentimeter slide-deck & AGY solver requests.
export function createServerHandler({
  fetchFn = globalThis.fetch,
  rootDir = __dirname,
  allowedOrigins = '*',
  timeoutMs = 10000,
  solveFn = (payload) => runAgySolver(payload),
  maxConcurrentSolves = 3,
} = {}) {
  const allowedOriginPolicy = parseAllowedOrigins(allowedOrigins);
  let activeSolves = 0;

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

        try {
          const resolvedSessionId = await resolveParticipationKey(sessionId, fetchFn, timeoutMs);
          const upstreamUrl = `https://api.mentimeter.com/audience/slide-deck/${encodeURIComponent(resolvedSessionId)}`;
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
          if (error?.statusCode && error?.code) {
            sendJson(res, error.statusCode, { error: error.code, message: error.message }, corsHeaders);
            return;
          }
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

      if (pathname === '/api/solve') {
        if (method === 'OPTIONS') {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }

        if (method !== 'POST') {
          sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Use POST.' }, corsHeaders);
          return;
        }

        let validated;
        try {
          const body = await readJsonBody(req);
          validated = validateSolvePayload(body);
        } catch (error) {
          if (error?.code === 'PAYLOAD_TOO_LARGE') {
            sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE', message: error.message }, corsHeaders);
            return;
          }
          sendJson(
            res,
            400,
            { error: error?.code || 'INVALID_SOLVE_REQUEST', message: error?.message || 'Invalid solve request.' },
            corsHeaders,
          );
          return;
        }

        if (activeSolves >= maxConcurrentSolves) {
          sendJson(
            res,
            429,
            { error: 'SOLVER_BUSY', message: 'AGY solver is busy right now. Please try again in a few seconds.' },
            { ...corsHeaders, 'Retry-After': '5' },
          );
          return;
        }

        activeSolves += 1;
        try {
          const solved = await solveFn(validated);
          sendJson(res, 200, solved, corsHeaders);
        } catch (error) {
          if (error?.code === 'SOLVER_TIMEOUT') {
            sendJson(res, 504, { error: 'SOLVER_TIMEOUT', message: error.message }, corsHeaders);
          } else if (error?.code === 'SOLVER_UNAVAILABLE') {
            sendJson(res, 503, { error: 'SOLVER_UNAVAILABLE', message: error.message }, corsHeaders);
          } else {
            sendJson(res, 502, { error: error?.code || 'SOLVER_FAILED', message: error?.message || 'AGY solver failed.' }, corsHeaders);
          }
        } finally {
          activeSolves -= 1;
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
