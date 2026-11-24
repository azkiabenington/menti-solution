import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  buildSlideDeckUrl,
  buildSolveBatches,
  buildSolveUrl,
  classifyFetchFailure,
  computeNextThemePreference,
  fetchSlideDeck,
  filterQuestions,
  getUnsolvedQuestions,
  mergeAiSolutions,
  queryLnaPermissionSafe,
  requestAiSolve,
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

  it('filters questions by question text, option labels, or answers case-insensitively', () => {
    const questions = [
      {
        id: '1',
        type: 'quiz-choice',
        question: 'ENIAC adalah komputer apa?',
        options: [{ title: 'Komputer digital elektronik', isCorrect: false }],
      },
      {
        id: '2',
        type: 'quiz-open',
        question: 'Nama belakang Ada?',
        answers: ['Lovelace'],
      },
    ];

    assert.equal(filterQuestions(questions, '').length, 2);
    assert.deepEqual(filterQuestions(questions, 'lovelace').map((q) => q.id), ['2']);
    assert.deepEqual(filterQuestions(questions, 'elektronik').map((q) => q.id), ['1']);
    assert.equal(filterQuestions(questions, 'nonexistent').length, 0);
  });

  it('requests AGY AI solver and merges solutions without mutating inputs', async () => {
    assert.equal(buildSolveUrl(''), '/api/solve');
    assert.equal(buildSolveUrl('https://adg.example.com/'), 'https://adg.example.com/api/solve');

    const questions = [
      {
        id: 'q1',
        type: 'quiz-choice',
        question: 'Alat hitung manik?',
        options: [
          { title: 'Sempoa', isCorrect: false },
          { title: 'Astrolab', isCorrect: false },
        ],
      },
    ];

    let capturedBody = null;
    const solved = await requestAiSolve(questions, {
      apiBase: 'https://adg.example.com',
      context: 'Sejarah',
      fetchFn: async (url, init) => {
        assert.equal(url, 'https://adg.example.com/api/solve');
        assert.equal(init.method, 'POST');
        capturedBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            model: 'gemini-3.8-flash-high',
            effort: 'high',
            solutions: [{ id: 'q1', choiceIndex: 0, answer: 'Sempoa', reason: 'Alat manik kuno.' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    assert.equal(capturedBody.context, 'Sejarah');
    assert.deepEqual(capturedBody.questions[0].options, ['Sempoa', 'Astrolab']);
    assert.equal(solved.model, 'gemini-3.8-flash-high');

    const merged = mergeAiSolutions(questions, solved.solutions, solved.model);
    assert.equal(questions[0].aiSolution, undefined);
    assert.deepEqual(merged[0].aiSolution, {
      choiceIndex: 0,
      answer: 'Sempoa',
      reason: 'Alat manik kuno.',
      model: 'gemini-3.8-flash-high',
    });

    const html = await fs.readFile(INDEX_HTML_PATH, 'utf8');
    assert.match(html, /id=["']aiContextInput["']/i);
  });

  it('selects unsolved questions, splits into progressive batches, and forwards abort signal', async () => {
    const questions = [
      { id: '1', type: 'quiz-open', question: 'Ada?', answers: ['Lovelace'] },
      { id: '2', type: 'quiz-open', question: 'Blank?', answers: [] },
      { id: '3', type: 'quiz-choice', question: 'Q3?', options: [{ title: 'A', isCorrect: true }], hasCorrectAnswer: true },
      { id: '4', type: 'quiz-choice', question: 'Q4?', options: [{ title: 'A', isCorrect: false }], hasCorrectAnswer: false },
      { id: '5', type: 'quiz-choice', question: 'Q5?', options: [{ title: 'A', isCorrect: false }], hasCorrectAnswer: false },
      { id: '6', type: 'quiz-choice', question: 'Q6?', options: [{ title: 'A', isCorrect: false }], hasCorrectAnswer: false },
      { id: '7', type: 'quiz-choice', question: 'Q7?', options: [{ title: 'A', isCorrect: false }], hasCorrectAnswer: false },
      { id: '8', type: 'quiz-choice', question: 'Q8?', options: [{ title: 'A', isCorrect: false }], hasCorrectAnswer: false },
      { id: '9', type: 'quiz-choice', question: 'Q9?', options: [{ title: 'A', isCorrect: false }], hasCorrectAnswer: false },
    ];

    const unsolved = getUnsolvedQuestions(questions);
    assert.deepEqual(unsolved.map((q) => q.id), ['2', '4', '5', '6', '7', '8', '9']);

    const batches = buildSolveBatches(unsolved);
    assert.deepEqual(
      batches.map((b) => b.map((q) => q.id)),
      [['2', '4'], ['5', '6', '7'], ['8', '9']],
    );

    const controller = new AbortController();
    let seenSignal = null;
    await requestAiSolve([unsolved[0]], {
      apiBase: '',
      signal: controller.signal,
      fetchFn: async (_url, init) => {
        seenSignal = init.signal;
        return new Response(
          JSON.stringify({ model: 'gemini-3.8-flash-high', solutions: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    assert.equal(seenSignal, controller.signal);

    const html = await fs.readFile(INDEX_HTML_PATH, 'utf8');
    assert.match(html, /<section[^>]+id=["']toolsStack["'][^>]*\bhidden\b/i);
    assert.match(html, /<button[^>]+id=["']toggleToolsBtn["'][^>]+aria-controls=["']toolsStack["']/i);
  });
});
