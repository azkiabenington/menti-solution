import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_API_BASE, normalizeApiBase, resolveApiBase, resolveDefaultApiBase } from '../config.js';
import { createServerHandler } from '../server.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startTestServer(options = {}) {
  const server = http.createServer(createServerHandler({ rootDir: REPO_ROOT, ...options }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('config helpers', () => {
  it('normalizes valid HTTP(S) bases and rejects non-HTTP schemes', () => {
    assert.equal(DEFAULT_API_BASE, '');
    assert.equal(normalizeApiBase(''), '');
    assert.equal(normalizeApiBase('   '), '');
    assert.equal(normalizeApiBase('https://adg.example.com/'), 'https://adg.example.com');
    assert.equal(normalizeApiBase('http://localhost:3000/api///'), 'http://localhost:3000/api');
    assert.throws(() => normalizeApiBase('javascript:alert(1)'), /INVALID_API_BASE/);
    assert.throws(() => normalizeApiBase('ftp://example.com'), /INVALID_API_BASE/);
    assert.throws(() => normalizeApiBase('not-a-url'), /INVALID_API_BASE/);
  });

  it('resolves apiBase with search > storage > defaultBase priority and ignores invalid overrides', () => {
    const mockStorage = {
      map: new Map([['menti_api_base', 'https://stored.example.com/']]),
      getItem(k) { return this.map.get(k) ?? null; },
    };

    assert.equal(
      resolveApiBase({
        search: '?apiBase=https%3A%2F%2Fquery.example.com%2F',
        storage: mockStorage,
        defaultBase: 'https://default.example.com',
      }),
      'https://query.example.com',
    );

    assert.equal(
      resolveApiBase({
        search: '?apiBase=javascript:alert(1)',
        storage: mockStorage,
        defaultBase: 'https://default.example.com',
      }),
      'https://stored.example.com',
    );

    assert.equal(
      resolveApiBase({
        search: '',
        storage: null,
        defaultBase: 'https://default.example.com/',
      }),
      'https://default.example.com',
    );

    assert.equal(
      resolveDefaultApiBase('azkiabenington.github.io'),
      'https://admin-adg.tail595888.ts.net',
    );
    assert.equal(resolveDefaultApiBase('127.0.0.1'), '');
  });
});

describe('server endpoints', () => {
  const closers = [];
  after(async () => {
    await Promise.all(closers.map((fn) => fn()));
  });

  it('serves /health and allows only whitelisted static assets', async () => {
    const srv = await startTestServer();
    closers.push(srv.close);

    const healthRes = await fetch(`${srv.baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    assert.deepEqual(await healthRes.json(), { ok: true });

    const indexRes = await fetch(`${srv.baseUrl}/`);
    assert.equal(indexRes.status, 200);
    assert.match(indexRes.headers.get('content-type') || '', /^text\/html/);

    const parserRes = await fetch(`${srv.baseUrl}/parser.js`);
    assert.equal(parserRes.status, 200);
    assert.match(parserRes.headers.get('content-type') || '', /^application\/javascript/);

    for (const blocked of ['/server.mjs', '/../package.json', '/docs/superpowers/specs/2026-11-24-mentimeter-slide-deck-design.md']) {
      const blockedRes = await fetch(`${srv.baseUrl}${blocked}`);
      assert.equal(blockedRes.status, 404, `Expected 404 for ${blocked}`);
    }
  });

  it('validates sessionId and enforces ALLOWED_ORIGINS CORS allowlist', async () => {
    const srv = await startTestServer({ allowedOrigins: ['https://allowed.github.io'] });
    closers.push(srv.close);

    const missingRes = await fetch(`${srv.baseUrl}/api/slide-deck`);
    assert.equal(missingRes.status, 400);
    assert.equal((await missingRes.json()).error, 'INVALID_SESSION_ID');

    const badRes = await fetch(`${srv.baseUrl}/api/slide-deck?sessionId=../etc`);
    assert.equal(badRes.status, 400);
    assert.equal((await badRes.json()).error, 'INVALID_SESSION_ID');

    const allowedPreflight = await fetch(`${srv.baseUrl}/api/slide-deck`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://allowed.github.io' },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), 'https://allowed.github.io');

    const deniedPreflight = await fetch(`${srv.baseUrl}/api/slide-deck`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://other.example' },
    });
    assert.equal(deniedPreflight.status, 204);
    assert.equal(deniedPreflight.headers.get('access-control-allow-origin'), null);
  });

  it('proxies 200 JSON and maps upstream 404, non-JSON 502, and timeout 504 cleanly', async () => {
    let mode = 'ok';
    let requestedUrl = '';

    const mockFetch = async (url) => {
      requestedUrl = url;
      if (mode === 'ok') {
        return new Response(JSON.stringify({ slide_deck: { name: 'Demo', slides: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (mode === 'not_found') {
        return new Response(JSON.stringify({ message: 'Not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (mode === 'non_json') {
        return new Response('<html>Bad Gateway</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      const err = new Error('Timed out');
      err.name = 'TimeoutError';
      throw err;
    };

    const srv = await startTestServer({ fetchFn: mockFetch, allowedOrigins: '*' });
    closers.push(srv.close);

    mode = 'ok';
    const okRes = await fetch(`${srv.baseUrl}/api/slide-deck?sessionId=al742i1zxz7c`);
    assert.equal(requestedUrl, 'https://api.mentimeter.com/audience/slide-deck/al742i1zxz7c');
    assert.equal(okRes.status, 200);
    assert.equal(okRes.headers.get('cache-control'), 'no-store');
    assert.equal(okRes.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await okRes.json(), { slide_deck: { name: 'Demo', slides: [] } });

    mode = 'not_found';
    const nfRes = await fetch(`${srv.baseUrl}/api/slide-deck?sessionId=al742i1zxz7c`);
    assert.equal(nfRes.status, 404);
    assert.equal((await nfRes.json()).error, 'QUIZ_NOT_FOUND');

    mode = 'non_json';
    const htmlRes = await fetch(`${srv.baseUrl}/api/slide-deck?sessionId=al742i1zxz7c`);
    assert.equal(htmlRes.status, 502);
    assert.equal((await htmlRes.json()).error, 'UPSTREAM_ERROR');

    mode = 'timeout';
    const toRes = await fetch(`${srv.baseUrl}/api/slide-deck?sessionId=al742i1zxz7c`);
    assert.equal(toRes.status, 504);
    assert.equal((await toRes.json()).error, 'UPSTREAM_TIMEOUT');
  });

  it('returns 400 BAD_REQUEST on malformed request URL instead of throwing', async () => {
    const handler = createServerHandler({ rootDir: REPO_ROOT });
    let statusCode = 0;
    let body = '';
    const mockRes = {
      headersSent: false,
      writeHead(code) {
        statusCode = code;
        this.headersSent = true;
      },
      end(chunk) {
        body = String(chunk || '');
      },
    };

    await handler({ method: 'GET', url: '//', headers: {} }, mockRes);
    assert.equal(statusCode, 400);
    assert.equal(JSON.parse(body).error, 'BAD_REQUEST');
  });
});
