const SESSION_ID_RE = /^[a-z0-9_-]{4,64}$/i;

/**
 * Validate whether a string matches Mentimeter's session/participation ID format.
 * @param {unknown} sessionId
 * @returns {boolean}
 */
export function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId.trim());
}

/**
 * Extract a validated Mentimeter session ID from a URL or bare session code.
 * @param {unknown} input
 * @returns {string | null}
 */
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

function normalizeQuizQuestion(id, rawType, question, choices, textKey) {
  if (rawType === 'quiz-open' || rawType === 'quiz_open') {
    const answers = choices
      .map((choice) => nonEmptyText(choice?.[textKey] ?? choice?.title ?? choice?.label))
      .filter(Boolean);
    return { id, type: 'quiz-open', question, answers };
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
      options,
      hasCorrectAnswer: options.some((option) => option.isCorrect),
    };
  }

  return null;
}

/**
 * Normalize Mentimeter slide_deck or legacy series payloads into question items.
 * @param {unknown} payload
 * @returns {{ deckTitle: string, totalSlides: number, questions: Array<object> }}
 */
export function parseSlideDeckPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('INVALID_PAYLOAD');
  }

  if (Array.isArray(payload.slide_deck?.slides)) {
    const { slides, name } = payload.slide_deck;
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
      const choices = contents.flatMap((item) => (Array.isArray(item?.choices) ? item.choices : []));
      const id = nonEmptyText(slide?.slide_public_key) || `slide-${i + 1}`;
      const normalized = normalizeQuizQuestion(id, slideType, question, choices, 'title');
      if (normalized) questions.push(normalized);
    }

    return {
      deckTitle: nonEmptyText(name),
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
      );
      if (normalized) questions.push(normalized);
    }

    return {
      deckTitle: nonEmptyText(name),
      totalSlides: rawQuestions.length,
      questions,
    };
  }

  throw new Error('INVALID_PAYLOAD');
}
