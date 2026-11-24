import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  AGY_EFFORT,
  AGY_MODEL,
  buildSolvePrompt,
  parseAgySolverOutput,
  runAgySolver,
  validateSolvePayload,
} from '../solver.mjs';

describe('AGY solver helpers', () => {
  it('locks model configuration to gemini-3.8-flash-low with low effort', () => {
    assert.equal(AGY_MODEL, 'gemini-3.8-flash-low');
    assert.equal(AGY_EFFORT, 'low');
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

  it('invokes agy CLI with sandbox, low effort, and isolated temp cwd, then cleans temp dir', async () => {
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
    assert.equal(capturedArgs[capturedArgs.indexOf('--model') + 1], 'gemini-3.8-flash-low');
    assert.equal(capturedArgs[capturedArgs.indexOf('--effort') + 1], 'low');
    assert.ok(capturedArgs.includes('--disable-slash-commands'));
    assert.ok(capturedArgs.includes('--sandbox'));
    assert.equal(capturedArgs[capturedArgs.indexOf('--output-format') + 1], 'json');
    assert.equal(capturedOpts.env.DBUS_SESSION_BUS_ADDRESS, undefined);
    assert.equal(result.model, 'gemini-3.8-flash-low');
    assert.equal(result.effort, 'low');
    assert.equal(result.solutions[0].answer, 'Sempoa');

    await assert.rejects(() => fs.stat(capturedOpts.cwd));
    const prompt = buildSolvePrompt(
      [{ id: 'q1', type: 'quiz-choice', question: 'Q?', options: ['A', 'B'] }],
      'Context',
    );
    assert.match(prompt, /Context/);
  });
});
