import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  AGY_EFFORT,
  AGY_MODEL,
  DEFAULT_SOLVE_TIMEOUT_MS,
  buildSolvePrompt,
  parseAgySolverOutput,
  runAgySolver,
  validateSolvePayload,
} from '../solver.mjs';

describe('AGY solver helpers', () => {
  it('locks model configuration to gemini-3.8-flash-high with high effort and 120s timeout', () => {
    assert.equal(AGY_MODEL, 'gemini-3.8-flash-high');
    assert.equal(AGY_EFFORT, 'high');
    assert.equal(DEFAULT_SOLVE_TIMEOUT_MS, 120000);
  });

  it('validates and normalizes solve payloads while rejecting malformed or oversized requests', () => {
    const clean = validateSolvePayload({
      context: '  Materi Sejarah Komputer  ',
      questions: [
        {
          id: 'q1',
          type: 'quiz-choice',
          question: 'Alat hitung manik-manik?',
          options: ['Sempoa', 'Astrolab'],
        },
        {
          id: 'q2',
          type: 'quiz-open',
          question: 'Nama belakang Ada?',
        },
      ],
    });

    assert.equal(clean.context, 'Materi Sejarah Komputer');
    assert.equal(clean.questions.length, 2);
    assert.deepEqual(clean.questions[0].options, ['Sempoa', 'Astrolab']);
    assert.deepEqual(clean.questions[1].options, []);

    assert.throws(() => validateSolvePayload(null), (err) => err.code === 'INVALID_SOLVE_REQUEST');
    assert.throws(() => validateSolvePayload({ questions: [] }), (err) => err.code === 'INVALID_SOLVE_REQUEST');
    assert.throws(
      () => validateSolvePayload({ questions: [{ id: 'q1', type: 'quiz-choice', question: 'Q?', options: [] }] }),
      (err) => err.code === 'INVALID_SOLVE_REQUEST',
    );
    assert.throws(
      () => validateSolvePayload({ questions: Array.from({ length: 51 }, (_, i) => ({ id: `q${i}`, type: 'quiz-open', question: 'Q?' })) }),
      (err) => err.code === 'INVALID_SOLVE_REQUEST',
    );
    assert.throws(
      () => validateSolvePayload({ context: 'x'.repeat(2500), questions: [{ id: 'q1', type: 'quiz-open', question: 'Q?' }] }),
      (err) => err.code === 'INVALID_SOLVE_REQUEST',
    );
  });

  it('parses direct and markdown-fenced JSON from AGY CLI response envelopes', () => {
    const questions = [
      { id: 'q1', type: 'quiz-choice', question: 'Alat hitung?', options: ['Sempoa', 'Astrolab'] },
      { id: 'q2', type: 'quiz-open', question: 'Nama belakang Ada?', options: [] },
    ];

    const wrapped = JSON.stringify({
      status: 'SUCCESS',
      response: '```json\n{"solutions":[{"id":"q1","choiceIndex":0,"answer":"wrong label ignored","reason":"Sempoa memakai manik-manik."},{"id":"q2","choiceIndex":null,"answer":"Lovelace","reason":"Ada Lovelace."}]}\n```',
    });

    const parsed = parseAgySolverOutput(wrapped, questions);
    assert.deepEqual(parsed, [
      { id: 'q1', choiceIndex: 0, answer: 'Sempoa', reason: 'Sempoa memakai manik-manik.' },
      { id: 'q2', choiceIndex: null, answer: 'Lovelace', reason: 'Ada Lovelace.' },
    ]);

    const matchByTitle = JSON.stringify({
      status: 'SUCCESS',
      response: '{"solutions":[{"id":"q1","choiceIndex":99,"answer":"Astrolab","reason":"Fallback match."}]}',
    });
    assert.equal(parseAgySolverOutput(matchByTitle, questions)[0].choiceIndex, 1);

    assert.throws(
      () => parseAgySolverOutput(JSON.stringify({ status: 'ERROR', response: '' }), questions),
      (err) => err.code === 'SOLVER_FAILED',
    );
  });

  it('invokes agy CLI with sandbox, high effort, date context, failover, and cleans temp dir', async () => {
    let capturedBin = '';
    let capturedArgs = [];
    let capturedOpts = null;

    const mockExecFile = async (bin, args, opts) => {
      capturedBin = bin;
      capturedArgs = args;
      capturedOpts = opts;
      const stat = await fs.stat(opts.cwd);
      assert.equal(stat.isDirectory(), true);

      return {
        stdout: JSON.stringify({
          status: 'SUCCESS',
          duration_seconds: 2.1,
          response: JSON.stringify({
            solutions: [{ id: 'q1', choiceIndex: 0, answer: 'Sempoa', reason: 'Cocok.' }],
          }),
        }),
        stderr: '',
      };
    };

    const result = await runAgySolver({
      questions: [{ id: 'q1', type: 'quiz-choice', question: 'Alat hitung?', options: ['Sempoa', 'Astrolab'] }],
      context: 'Kuis komputer',
      agyBin: '/custom/bin/agy',
      execFileFn: mockExecFile,
    });

    assert.equal(capturedBin, '/custom/bin/agy');
    assert.ok(capturedArgs.includes('--model'));
    assert.equal(capturedArgs[capturedArgs.indexOf('--model') + 1], 'gemini-3.8-flash-high');
    assert.equal(capturedArgs[capturedArgs.indexOf('--effort') + 1], 'high');
    assert.ok(capturedArgs.includes('--disable-slash-commands'));
    assert.ok(capturedArgs.includes('--sandbox'));
    assert.equal(capturedArgs[capturedArgs.indexOf('--output-format') + 1], 'json');
    assert.equal(capturedOpts.env.DBUS_SESSION_BUS_ADDRESS, undefined);
    assert.equal(result.model, 'gemini-3.8-flash-high');
    assert.equal(result.effort, 'high');
    assert.equal(result.solutions[0].answer, 'Sempoa');

    await assert.rejects(() => fs.stat(capturedOpts.cwd));

    const attemptedBins = [];
    const fallbackResult = await runAgySolver({
      questions: [{ id: 'q1', type: 'quiz-choice', question: 'Alat hitung?', options: ['Sempoa', 'Astrolab'] }],
      agyBins: ['/bin/agy-akun1', '/bin/agy-akun2'],
      execFileFn: async (bin) => {
        attemptedBins.push(bin);
        if (bin === '/bin/agy-akun1') {
          const err = new Error('authentication required');
          err.code = 1;
          err.stderr = 'Error: authentication required. Run agy to log in.';
          throw err;
        }
        return {
          stdout: JSON.stringify({
            status: 'SUCCESS',
            response: JSON.stringify({
              solutions: [{ id: 'q1', choiceIndex: 0, answer: 'Sempoa', reason: 'Ok.' }],
            }),
          }),
        };
      },
    });
    assert.deepEqual(attemptedBins, ['/bin/agy-akun1', '/bin/agy-akun2']);
    assert.equal(fallbackResult.solutions[0].answer, 'Sempoa');

    const prompt = buildSolvePrompt(
      [{ id: 'q1', type: 'quiz-choice', question: 'Q?', options: ['A', 'B'] }],
      'Context',
      new Date('2026-11-24T00:00:00Z'),
    );
    assert.match(prompt, /Context/);
    assert.match(prompt, /2026-11-24/);
    assert.match(prompt, /NEVER call run_command/i);
    assert.match(prompt, /ONE parallel batch of search_web/i);
  });
});
