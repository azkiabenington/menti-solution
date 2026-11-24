import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  buildSlideDeckUrl,
  classifyFetchFailure,
  computeNextThemePreference,
  fetchSlideDeck,
  queryLnaPermissionSafe,
} from '../index.js';

const INDEX_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'index.html',
);

describe('web UI client helpers', () => {
  it('builds /api/slide-deck URLs for same-origin and configured API base', () => {
    assert.equal(buildSlideDeckUrl('al742i1zxz7c', ''), '/api/slide-deck?sessionId=al742i1zxz7c');
    assert.equal(
      buildSlideDeckUrl('al742i1zxz7c', 'https://adg.example.com'),
      'https://adg.example.com/api/slide-deck?sessionId=al742i1zxz7c',
    );
  });

  it('classifies static HTML 404 or missing backend failures with actionable guidance', () => {
    const static404 = classifyFetchFailure(404, 'text/html; charset=utf-8', '');
    assert.equal(static404.code, 'STATIC_CORS_HINT');
    assert.match(static404.message, /Backend API Host|Paste JSON/i);

    const quiz404 = classifyFetchFailure(404, 'application/json', '');
    assert.equal(quiz404.code, 'NOT_FOUND');

    const upstream502 = classifyFetchFailure(502, 'application/json', 'https://adg.example.com');
    assert.equal(upstream502.code, 'UPSTREAM_ERROR');
  });

  it('fetches and parses 200 JSON and maps 404, non-JSON, and network failures', async () => {
    const validPayload = {
      slide_deck: {
        name: 'Quiz Demo',
        slides: [
          {
            slide_public_key: 'q1',
            static_content: { type: 'quiz-open' },
            interactive_contents: [{ title: 'Who?', choices: [{ title: 'Ada' }] }],
          },
        ],
      },
    };

    const parsed = await fetchSlideDeck('al742i1zxz7c', {
      apiBase: '',
      fetchFn: async () => new Response(JSON.stringify(validPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    assert.equal(parsed.deckTitle, 'Quiz Demo');
    assert.equal(parsed.questions[0].answers[0], 'Ada');

    await assert.rejects(
      () => fetchSlideDeck('missing123', {
        apiBase: 'https://adg.example.com',
        fetchFn: async () => new Response(JSON.stringify({ error: 'QUIZ_NOT_FOUND', message: 'Not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      }),
      (err) => err.code === 'NOT_FOUND',
    );

    await assert.rejects(
      () => fetchSlideDeck('al742i1zxz7c', {
        apiBase: '',
        fetchFn: async () => new Response('<html>GitHub Pages 404</html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
      }),
      (err) => err.code === 'STATIC_CORS_HINT',
    );

    await assert.rejects(
      () => fetchSlideDeck('al742i1zxz7c', {
        apiBase: '',
        fetchFn: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
      (err) => err.code === 'STATIC_CORS_HINT',
    );

    await assert.rejects(
      () => fetchSlideDeck('al742i1zxz7c', {
        apiBase: 'https://adg.example.com',
        fetchFn: async () => new Response('<html>Bad Gateway</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      }),
      (err) => err.code === 'INVALID_RESPONSE',
    );
  });

  it('includes a classic script fallback in index.html that explains file:// module blocking', async () => {
    const html = await fs.readFile(INDEX_HTML_PATH, 'utf8');
    const matches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)];
    const fileFallback = matches.find(
      (m) => !/type=["']module["']/i.test(m[0]) && m[1].includes('file:'),
    );
    assert.ok(fileFallback, 'Expected an inline classic <script> fallback for file:// protocol');

    const solutionNode = { className: 'empty', textContent: '', replaceChildren(node) { this.textContent = node?.textContent ?? ''; } };
    const pNode = { className: '', textContent: '' };
    const ctx = {
      window: { location: { protocol: 'file:' } },
      document: {
        getElementById: (id) => (id === 'solution' ? solutionNode : null),
        createElement: () => pNode,
      },
    };
    vm.runInNewContext(fileFallback[1], ctx);
    assert.equal(solutionNode.className, 'error');
    assert.match(solutionNode.textContent, /npm start|localhost|github\.io|userscript/i);
  });

  it('computes two-state color scheme toggle overrides and declares meta color-scheme in index.html', async () => {
    assert.equal(computeNextThemePreference(null, false), 'dark');
    assert.equal(computeNextThemePreference('dark', false), null);
    assert.equal(computeNextThemePreference('dark', true), 'light');
    assert.equal(computeNextThemePreference('light', true), null);

    const html = await fs.readFile(INDEX_HTML_PATH, 'utf8');
    assert.match(html, /<meta\s+name=["']color-scheme["']\s+content=["']light dark["']>/i);
    assert.match(html, /id=["']themeToggleBtn["']/i);
  });

  it('detects denied local-network permission safely and surfaces remediation message', async () => {
    assert.equal(await queryLnaPermissionSafe({ query: async () => ({ state: 'denied' }) }), 'denied');
    assert.equal(await queryLnaPermissionSafe({ query: async () => { throw new TypeError('Unsupported'); } }), 'prompt');

    await assert.rejects(
      () => fetchSlideDeck('al742i1zxz7c', {
        apiBase: 'https://admin-adg.tail595888.ts.net',
        fetchFn: async () => { throw new TypeError('Failed to fetch'); },
        permissions: { query: async () => ({ state: 'denied' }) },
      }),
      (err) => err.code === 'LNA_DENIED' && /Local network/i.test(err.message),
    );
  });
});
