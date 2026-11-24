const SESSION_ID_RE = /^[a-z0-9_-]{4,64}$/i;

// Validates Mentimeter participation keys and rejects path/query metacharacters.
export function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId.trim());
}

// Accepts full menti.com URLs, bare host paths, or raw session IDs; rejects foreign hosts.
export function extractMentiSessionId(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (isValidSessionId(trimmed)) {
    return trimmed;
  }

  const candidate = /^(?:www\.)?menti\.com(?:\/|$)/i.test(trimmed)
    ? `https://${trimmed}`
    : trimmed;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== 'menti.com' && !host.endsWith('.menti.com')) {
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const lastSegment = segments.at(-1);
  return isValidSessionId(lastSegment) ? lastSegment.trim() : null;
}

function nonEmptyText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCountdown(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeQuizQuestion(id, rawType, question, choices, textKey, countdown = null) {
  const normalizedCountdown = normalizeCountdown(countdown);

  if (rawType === 'quiz-open' || rawType === 'quiz_open') {
    const answers = choices
      .map((choice) => nonEmptyText(choice?.[textKey] ?? choice?.title ?? choice?.label))
      .filter(Boolean);
    return { id, type: 'quiz-open', question, countdown: normalizedCountdown, answers };
  }

  if (rawType === 'quiz-choice' || rawType === 'quiz') {
    const options = choices
      .map((choice) => ({
        title: nonEmptyText(choice?.[textKey] ?? choice?.title ?? choice?.label),
        isCorrect: choice?.correct_answer === true,
      }))
      .filter((option) => option.title.length > 0);
    return {
      id,
      type: 'quiz-choice',
      question,
      countdown: normalizedCountdown,
      options,
      hasCorrectAnswer: options.some((option) => option.isCorrect),
    };
  }

  return null;
}

// Normalizes current slide_deck payloads and legacy series payloads into a single shape.
export function parseSlideDeckPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('INVALID_PAYLOAD');
  }

  if (Array.isArray(payload.slide_deck?.slides)) {
    const { slides, name, participation_settings: participationSettings } = payload.slide_deck;
    const rawCode = participationSettings?.participation_code;
    const participationCode =
      rawCode !== null && rawCode !== undefined && String(rawCode).trim()
        ? String(rawCode).trim()
        : null;
    const questions = [];

    for (let i = 0; i < slides.length; i += 1) {
      const slide = slides[i];
      const slideType = slide?.static_content?.type;
      if (slideType !== 'quiz-open' && slideType !== 'quiz-choice') {
        continue;
      }

      const contents = Array.isArray(slide.interactive_contents) ? slide.interactive_contents : [];
      const primary = contents[0];
      const question = nonEmptyText(primary?.title) || nonEmptyText(slide?.title);
      const countdown = primary?.countdown ?? slide?.countdown ?? null;
      const choices = contents.flatMap((item) => (Array.isArray(item?.choices) ? item.choices : []));
      const id = nonEmptyText(slide?.slide_public_key) || `slide-${i + 1}`;
      const normalized = normalizeQuizQuestion(id, slideType, question, choices, 'title', countdown);
      if (normalized) questions.push(normalized);
    }

    return {
      deckTitle: nonEmptyText(name),
      participationCode,
      totalSlides: slides.length,
      questions,
    };
  }

  if (Array.isArray(payload.series?.questions)) {
    const { questions: rawQuestions, name } = payload.series;
    const questions = [];

    for (let i = 0; i < rawQuestions.length; i += 1) {
      const item = rawQuestions[i];
      const id = nonEmptyText(item?.id) || `question-${i + 1}`;
      const choices = Array.isArray(item?.choices) ? item.choices : [];
      const normalized = normalizeQuizQuestion(
        id,
        item?.type,
        nonEmptyText(item?.question),
        choices,
        'label',
        item?.countdown ?? null,
      );
      if (normalized) questions.push(normalized);
    }

    return {
      deckTitle: nonEmptyText(name),
      participationCode: null,
      totalSlides: rawQuestions.length,
      questions,
    };
  }

  throw new Error('INVALID_PAYLOAD');
}

export function formatOptionLabel(index) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

// Formats one parsed question and its choices/answers for quick clipboard paste.
export function formatQuestionPrompt(item, index = 0) {
  const lines = [`${index + 1}. ${nonEmptyText(item?.question) || 'Untitled question'}`];

  if (item?.type === 'quiz-open') {
    const answers = Array.isArray(item.answers) ? item.answers.filter(Boolean) : [];
    if (answers.length > 0) {
      lines.push(`Accepted answer(s): ${answers.join(', ')}`);
    }
  } else if (item?.type === 'quiz-choice') {
    const options = Array.isArray(item.options) ? item.options : [];
    options.forEach((opt, optIndex) => {
      const prefix = `${formatOptionLabel(optIndex)}.`;
      lines.push(opt.isCorrect ? `${prefix} ${opt.title} [Correct]` : `${prefix} ${opt.title}`);
    });
  }

  return lines.join('\n');
}

export function formatDeckPrompt(parsed) {
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const formattedQuestions = questions.map((item, index) => formatQuestionPrompt(item, index));
  const title = nonEmptyText(parsed?.deckTitle);
  const body = formattedQuestions.join('\n\n');
  if (!title) return body;
  return body ? `Quiz: ${title}\n\n${body}` : `Quiz: ${title}`;
}

export function formatDeckMarkdown(parsed) {
  const title = nonEmptyText(parsed?.deckTitle) || 'Mentimeter Quiz';
  const lines = [`# ${title}`];
  const rawCode = parsed?.participationCode;
  const roomCode = rawCode !== null && rawCode !== undefined ? String(rawCode).trim() : '';
  if (roomCode) {
    lines.push('', `Room Code: \`${roomCode}\``);
  }

  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  questions.forEach((item, index) => {
    const countdown = normalizeCountdown(item?.countdown);
    const timer = countdown ? ` (${countdown}s)` : '';
    lines.push('', `## ${index + 1}. ${nonEmptyText(item?.question) || 'Untitled question'}${timer}`);

    if (item?.type === 'quiz-open') {
      const answers = Array.isArray(item.answers) ? item.answers.filter(Boolean) : [];
      if (answers.length === 0) {
        lines.push('- No accepted short answer returned.');
      } else {
        answers.forEach((ans) => lines.push(`- Answer: \`${ans}\``));
      }
    } else if (item?.type === 'quiz-choice') {
      const options = Array.isArray(item.options) ? item.options : [];
      options.forEach((opt, optIndex) => {
        const label = `${formatOptionLabel(optIndex)}.`;
        lines.push(opt.isCorrect ? `- ${label} ${opt.title} **[Correct]**` : `- ${label} ${opt.title}`);
      });
    }
  });

  return lines.join('\n');
}
