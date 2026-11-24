import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidSessionId,
  extractMentiSessionId,
  parseSlideDeckPayload,
  formatQuestionPrompt,
  formatDeckPrompt,
  formatDeckMarkdown,
} from '../parser.js';

describe('isValidSessionId', () => {
  it('accepts valid Mentimeter session codes', () => {
    assert.equal(isValidSessionId('al742i1zxz7c'), true);
    assert.equal(isValidSessionId('abc_123-XYZ'), true);
  });

  it('rejects empty, short, invalid, or traversal strings', () => {
    assert.equal(isValidSessionId(''), false);
    assert.equal(isValidSessionId('abc'), false);
    assert.equal(isValidSessionId('../secret'), false);
    assert.equal(isValidSessionId('a/b'), false);
    assert.equal(isValidSessionId(null), false);
  });
});

describe('extractMentiSessionId', () => {
  it('extracts session IDs from full, bare-host, trailing-slash, and raw inputs', () => {
    assert.equal(extractMentiSessionId('https://www.menti.com/al742i1zxz7c'), 'al742i1zxz7c');
    assert.equal(extractMentiSessionId('https://www.menti.com/al742i1zxz7c/?ref=1#slide'), 'al742i1zxz7c');
    assert.equal(extractMentiSessionId('https://menti.com/p/al742i1zxz7c'), 'al742i1zxz7c');
    assert.equal(extractMentiSessionId('menti.com/al742i1zxz7c/'), 'al742i1zxz7c');
    assert.equal(extractMentiSessionId('www.menti.com/al742i1zxz7c'), 'al742i1zxz7c');
    assert.equal(extractMentiSessionId('al742i1zxz7c'), 'al742i1zxz7c');
  });

  it('rejects non-menti domains, empty strings, and invalid path segments', () => {
    assert.equal(extractMentiSessionId(''), null);
    assert.equal(extractMentiSessionId('https://evil.com/al742i1zxz7c'), null);
    assert.equal(extractMentiSessionId('https://notmenti.com/al742i1zxz7c'), null);
    assert.equal(extractMentiSessionId('https://www.menti.com/'), null);
    assert.equal(extractMentiSessionId('../../etc/passwd'), null);
  });
});

describe('parseSlideDeckPayload', () => {
  it('parses the new slide_deck schema with quiz-choice and quiz-open slides', () => {
    const payload = {
      slide_deck: {
        name: 'Kuis Sejarah Komputer',
        participation_settings: { participation_code: 48139482 },
        slides: [
          {
            slide_public_key: 'intro1',
            title: 'Kuis Sejarah Komputer',
            static_content: { type: 'free-text' },
            interactive_contents: [],
          },
          {
            slide_public_key: 'q1',
            title: 'Alat hitung apakah yang menggunakan manik-manik?',
            static_content: { type: 'quiz-choice' },
            interactive_contents: [
              {
                title: 'Alat hitung apakah yang menggunakan manik-manik?',
                countdown: 30,
                choices: [
                  { title: 'Sempoa' },
                  { title: 'Astrolab' },
                  { title: 'Kalkulator mekanis' },
                  { title: 'Penggaris hitung' },
                ],
              },
            ],
          },
          {
            slide_public_key: 'q2',
            title: 'Apa nama keluarga Ada?',
            static_content: { type: 'quiz-open' },
            interactive_contents: [
              {
                title: 'Apa nama keluarga Ada?',
                countdown: 30,
                choices: [{ title: 'Lovelace' }, { title: '  ' }],
              },
            ],
          },
          {
            slide_public_key: 'q3-fallback',
            title: 'Fallback slide title',
            static_content: { type: 'quiz-open' },
            interactive_contents: [],
          },
          {
            slide_public_key: 'lb1',
            title: '',
            static_content: { type: 'leaderboard' },
            interactive_contents: [],
          },
        ],
      },
    };

    const result = parseSlideDeckPayload(payload);
    assert.equal(result.deckTitle, 'Kuis Sejarah Komputer');
    assert.equal(result.participationCode, '48139482');
    assert.equal(result.totalSlides, 5);
    assert.equal(result.questions.length, 3);

    assert.deepEqual(result.questions[0], {
      id: 'q1',
      type: 'quiz-choice',
      question: 'Alat hitung apakah yang menggunakan manik-manik?',
      countdown: 30,
      options: [
        { title: 'Sempoa', isCorrect: false },
        { title: 'Astrolab', isCorrect: false },
        { title: 'Kalkulator mekanis', isCorrect: false },
        { title: 'Penggaris hitung', isCorrect: false },
      ],
      hasCorrectAnswer: false,
    });

    assert.deepEqual(result.questions[1], {
      id: 'q2',
      type: 'quiz-open',
      question: 'Apa nama keluarga Ada?',
      countdown: 30,
      answers: ['Lovelace'],
    });

    assert.deepEqual(result.questions[2], {
      id: 'q3-fallback',
      type: 'quiz-open',
      question: 'Fallback slide title',
      countdown: null,
      answers: [],
    });
  });

  it('marks quiz-choice options when correct_answer is present', () => {
    const result = parseSlideDeckPayload({
      slide_deck: {
        name: 'Deck With Answers',
        slides: [
          {
            slide_public_key: 'qc1',
            static_content: { type: 'quiz-choice' },
            interactive_contents: [
              {
                title: '2 + 2?',
                choices: [
                  { title: '3', correct_answer: false },
                  { title: '4', correct_answer: true },
                ],
              },
            ],
          },
        ],
      },
    });

    assert.equal(result.questions[0].hasCorrectAnswer, true);
    assert.deepEqual(result.questions[0].options, [
      { title: '3', isCorrect: false },
      { title: '4', isCorrect: true },
    ]);
  });

  it('parses legacy series.questions format for backward compatibility', () => {
    const result = parseSlideDeckPayload({
      series: {
        name: 'Legacy Deck',
        questions: [
          {
            id: 'lq1',
            type: 'quiz_open',
            question: 'Capital of France?',
            choices: [{ label: 'Paris' }],
          },
          {
            id: 'lq2',
            type: 'quiz',
            question: 'Pick prime',
            choices: [
              { label: '4', correct_answer: false },
              { label: '5', correct_answer: true },
            ],
          },
        ],
      },
    });

    assert.equal(result.deckTitle, 'Legacy Deck');
    assert.equal(result.totalSlides, 2);
    assert.deepEqual(result.questions, [
      {
        id: 'lq1',
        type: 'quiz-open',
        question: 'Capital of France?',
        countdown: null,
        answers: ['Paris'],
      },
      {
        id: 'lq2',
        type: 'quiz-choice',
        question: 'Pick prime',
        countdown: null,
        options: [
          { title: '4', isCorrect: false },
          { title: '5', isCorrect: true },
        ],
        hasCorrectAnswer: true,
      },
    ]);
  });

  it('throws INVALID_PAYLOAD when payload is missing slide_deck and series', () => {
    assert.throws(() => parseSlideDeckPayload({}), /INVALID_PAYLOAD/);
    assert.throws(() => parseSlideDeckPayload(null), /INVALID_PAYLOAD/);
  });
});

describe('prompt copy formatters', () => {
  it('formats single quiz-choice and quiz-open questions and full decks cleanly', () => {
    const choiceText = formatQuestionPrompt(
      {
        id: 'q1',
        type: 'quiz-choice',
        question: 'Alat hitung kuno?',
        options: [
          { title: 'Sempoa', isCorrect: false },
          { title: 'Astrolab', isCorrect: false },
        ],
        hasCorrectAnswer: false,
      },
      0,
    );
    assert.equal(choiceText, '1. Alat hitung kuno?\nA. Sempoa\nB. Astrolab');

    const openText = formatQuestionPrompt(
      {
        id: 'q2',
        type: 'quiz-open',
        question: 'Nama keluarga Ada?',
        answers: ['Lovelace'],
      },
      1,
    );
    assert.equal(openText, '2. Nama keluarga Ada?\nAccepted answer(s): Lovelace');

    const deckText = formatDeckPrompt({
      deckTitle: 'Kuis Sejarah',
      totalSlides: 2,
      questions: [
        {
          id: 'q1',
          type: 'quiz-choice',
          question: 'Alat hitung kuno?',
          options: [{ title: 'Sempoa', isCorrect: false }],
          hasCorrectAnswer: false,
        },
        {
          id: 'q2',
          type: 'quiz-open',
          question: 'Nama keluarga Ada?',
          answers: ['Lovelace'],
        },
      ],
    });
    assert.match(deckText, /^Quiz: Kuis Sejarah\n\n1\. Alat hitung kuno\?\nA\. Sempoa\n\n2\. Nama keluarga Ada\?/);

    const md = formatDeckMarkdown({
      deckTitle: 'Kuis Sejarah',
      participationCode: '48139482',
      totalSlides: 2,
      questions: [
        {
          id: 'q1',
          type: 'quiz-choice',
          question: 'Alat hitung kuno?',
          countdown: 30,
          options: [{ title: 'Sempoa', isCorrect: false }],
          hasCorrectAnswer: false,
        },
        {
          id: 'q2',
          type: 'quiz-open',
          question: 'Nama keluarga Ada?',
          countdown: 30,
          answers: ['Lovelace'],
        },
      ],
    });
    assert.match(md, /^# Kuis Sejarah/);
    assert.match(md, /Room Code: `48139482`/);
    assert.match(md, /- A\. Sempoa/);
    assert.match(md, /- Answer: `Lovelace`/);
  });
});
