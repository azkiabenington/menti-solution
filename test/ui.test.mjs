import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSlideDeckUrl,
  classifyFetchFailure,
  fetchSlideDeck,
} from '../index.js';

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
});
