import { extractMentiSessionId, parseSlideDeckPayload } from './parser.js';
import {
  API_BASE_STORAGE_KEY,
  normalizeApiBase,
  resolveApiBase,
  resolveDefaultApiBase,
} from './config.js';

const COLOR_SCHEME_STORAGE_KEY = 'color-scheme';

export function buildSlideDeckUrl(sessionId, apiBase = '') {
  const cleanBase = normalizeApiBase(apiBase);
  const path = `/api/slide-deck?sessionId=${encodeURIComponent(sessionId)}`;
  return cleanBase ? `${cleanBase}${path}` : path;
}

// Two-state color scheme toggle: returns null when reverting to OS preference.
export function computeNextThemePreference(storedScheme, osPrefersDark) {
  const renderedDark = storedScheme ? storedScheme === 'dark' : Boolean(osPrefersDark);
  const target = renderedDark ? 'light' : 'dark';
  const osScheme = osPrefersDark ? 'dark' : 'light';
  return target === osScheme ? null : target;
}

export function classifyFetchFailure(status, contentType = '', apiBase = '', payload = null) {
  const isJson = String(contentType).toLowerCase().includes('application/json');

  if (status === 404 && !apiBase && !isJson) {
    return {
      code: 'STATIC_CORS_HINT',
      message:
        'Static hosting cannot call Mentimeter directly due to browser CORS. Configure Backend API Host below, use Paste JSON, or install the userscript.',
    };
  }

  if (status === 404) {
    return {
      code: 'NOT_FOUND',
      message: payload?.message || 'Mentimeter quiz was not found or is no longer active.',
    };
  }

  if (status === 400) {
    return {
      code: 'INVALID_INPUT',
      message: payload?.message || 'Invalid Mentimeter link or session code.',
    };
  }

  if (status === 504) {
    return {
      code: 'UPSTREAM_TIMEOUT',
      message: payload?.message || 'Mentimeter API timed out. Please try again.',
    };
  }

  return {
    code: 'UPSTREAM_ERROR',
    message: payload?.message || `Failed to fetch quiz data (HTTP ${status}).`,
  };
}

function createCodedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function fetchSlideDeck(
  sessionId,
  { apiBase = '', fetchFn = globalThis.fetch } = {},
) {
  const url = buildSlideDeckUrl(sessionId, apiBase);
  let response;

  try {
    response = await fetchFn(url, {
      headers: { accept: 'application/json' },
    });
  } catch {
    if (!apiBase) {
      throw createCodedError(
        'STATIC_CORS_HINT',
        'No backend proxy responded at /api/slide-deck. Start server.mjs, configure Backend API Host, or use Paste JSON.',
      );
    }
    throw createCodedError(
      'UPSTREAM_ERROR',
      'Could not reach the configured Backend API Host. Check the URL and CORS configuration, or use Paste JSON.',
    );
  }

  const contentType = response.headers?.get?.('content-type') || '';
  const rawText = await response.text();
  let parsedJson = null;

  if (rawText) {
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      parsedJson = null;
    }
  }

  if (!response.ok) {
    const classified = classifyFetchFailure(response.status, contentType, apiBase, parsedJson);
    throw createCodedError(classified.code, classified.message);
  }

  if (!parsedJson || typeof parsedJson !== 'object') {
    throw createCodedError(
      'INVALID_RESPONSE',
      'Backend returned a non-JSON response instead of quiz data.',
    );
  }

  return parseSlideDeckPayload(parsedJson);
}

function legacyCopy(text) {
  const previousFocus = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
    previousFocus?.focus?.({ preventScroll: true });
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return legacyCopy(text);
    }
  }
  return legacyCopy(text);
}

function safeStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors in restricted contexts.
  }
}

function safeStorageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors in restricted contexts.
  }
}

function initializeApp() {
  const form = document.getElementById('getAnswersForm');
  const mentiLinkInput = document.getElementById('mentiLink');
  const submitBtn = document.getElementById('getAnswers');
  const solutionEl = document.getElementById('solution');
  const toastEl = document.getElementById('statusToast');
  const noticeEl = document.getElementById('notice');
  const hideNoticeBtn = document.getElementById('hideNoticeBtn');
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeMeta = document.querySelector('meta[name="color-scheme"]');
  const apiBaseInput = document.getElementById('apiBaseInput');
  const activeApiSummary = document.getElementById('activeApiSummary');
  const apiBaseFeedback = document.getElementById('apiBaseFeedback');
  const saveApiBaseBtn = document.getElementById('saveApiBaseBtn');
  const resetApiBaseBtn = document.getElementById('resetApiBaseBtn');
  const rawJsonInput = document.getElementById('rawJsonInput');
  const parseRawJsonBtn = document.getElementById('parseRawJsonBtn');

  const colorSchemeQuery = window.matchMedia?.('(prefers-color-scheme: dark)');

  function readStoredScheme() {
    const stored = safeStorageGet(COLOR_SCHEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  }

  function syncThemeUi() {
    const stored = readStoredScheme();
    const osDark = Boolean(colorSchemeQuery?.matches);
    const activeDark = stored ? stored === 'dark' : osDark;
    if (themeMeta) {
      themeMeta.content = stored ?? 'light dark';
    }
    if (themeToggleBtn) {
      themeToggleBtn.textContent = activeDark ? 'Switch to Light' : 'Switch to Dark';
      themeToggleBtn.setAttribute('aria-pressed', String(stored !== null));
    }
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const next = computeNextThemePreference(readStoredScheme(), Boolean(colorSchemeQuery?.matches));
      if (next) {
        safeStorageSet(COLOR_SCHEME_STORAGE_KEY, next);
      } else {
        safeStorageRemove(COLOR_SCHEME_STORAGE_KEY);
      }
      syncThemeUi();
    });
  }

  colorSchemeQuery?.addEventListener?.('change', syncThemeUi);
  window.addEventListener('storage', (event) => {
    if (event.key === COLOR_SCHEME_STORAGE_KEY) syncThemeUi();
  });
  syncThemeUi();

  const defaultApiBase = resolveDefaultApiBase(window.location.hostname);
  let activeApiBase = resolveApiBase({
    search: window.location.search,
    storage: { getItem: safeStorageGet },
    defaultBase: defaultApiBase,
  });

  let toastTimer = null;
  let lastToastMessage = '';

  function showToast(rawMessage) {
    clearTimeout(toastTimer);
    // Toggling trailing NBSP forces VoiceOver to re-announce identical consecutive messages.
    const message = rawMessage === lastToastMessage ? `${rawMessage}\u00A0` : rawMessage;
    lastToastMessage = message;
    toastEl.textContent = message;
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
      toastEl.textContent = '';
    }, 2500);
  }

  function setStatusState(state, message) {
    solutionEl.className = state;
    if (state === 'loading') {
      solutionEl.setAttribute('aria-busy', 'true');
    } else {
      solutionEl.removeAttribute('aria-busy');
    }
    solutionEl.replaceChildren();
    const p = document.createElement('p');
    p.className = 'state-message';
    p.textContent = message;
    solutionEl.append(p);
  }

  function updateApiBaseDisplay() {
    apiBaseInput.value = activeApiBase;
    activeApiSummary.textContent = activeApiBase
      ? `Active API endpoint: ${activeApiBase}/api/slide-deck`
      : 'Active API endpoint: same-origin /api/slide-deck';
  }

  function renderParsedDeck(parsed) {
    solutionEl.className = 'success';
    solutionEl.removeAttribute('aria-busy');
    solutionEl.replaceChildren();

    const summary = document.createElement('div');
    summary.className = 'deck-summary';
    const titleEl = document.createElement('h2');
    titleEl.textContent = parsed.deckTitle || 'Mentimeter Quiz';
    const countsEl = document.createElement('p');
    const openCount = parsed.questions.filter((q) => q.type === 'quiz-open').length;
    const choiceCount = parsed.questions.filter((q) => q.type === 'quiz-choice').length;
    countsEl.textContent =
      `Slides: ${parsed.totalSlides} total | Questions: ${parsed.questions.length} ` +
      `(${openCount} short-answer, ${choiceCount} multiple-choice)`;
    summary.append(titleEl, countsEl);
    solutionEl.append(summary);

    if (parsed.questions.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.className = 'state-message';
      emptyMsg.textContent = 'No quiz questions were found in this slide deck.';
      solutionEl.append(emptyMsg);
      return;
    }

    parsed.questions.forEach((item, index) => {
      const card = document.createElement('article');
      card.className = 'question-card';

      const heading = document.createElement('h3');
      heading.textContent = `${index + 1}. ${item.question || 'Untitled question'}`;
      card.append(heading);

      if (item.type === 'quiz-open') {
        if (item.answers.length === 0) {
          const note = document.createElement('p');
          note.className = 'question-note';
          note.textContent = 'No accepted short answer was returned for this slide.';
          card.append(note);
        } else {
          item.answers.forEach((answerText) => {
            const row = document.createElement('div');
            row.className = 'answer-row';

            const label = document.createElement('span');
            label.className = 'answer-text';
            label.textContent = `Answer: ${answerText}`;

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'copy-button';
            copyBtn.textContent = 'Copy';
            copyBtn.setAttribute('aria-label', `Copy answer ${answerText}`);
            copyBtn.addEventListener('click', async () => {
              const copied = await copyTextToClipboard(answerText);
              showToast(copied ? 'Copied' : 'Copy failed');
            });

            row.append(label, copyBtn);
            card.append(row);
          });
        }
      } else if (item.type === 'quiz-choice') {
        if (item.options.length > 0) {
          const list = document.createElement('ul');
          list.className = 'choice-list';

          item.options.forEach((option) => {
            const li = document.createElement('li');
            if (option.isCorrect) {
              li.className = 'choice-item-correct';
              li.textContent = `${option.title} [Correct]`;
            } else {
              li.textContent = option.title;
            }
            list.append(li);
          });
          card.append(list);
        }

        if (item.hasCorrectAnswer) {
          const correctText = item.options
            .filter((o) => o.isCorrect)
            .map((o) => o.title)
            .join(', ');
          const copyBtn = document.createElement('button');
          copyBtn.type = 'button';
          copyBtn.className = 'copy-button';
          copyBtn.textContent = 'Copy Correct';
          copyBtn.setAttribute('aria-label', `Copy correct answer ${correctText}`);
          copyBtn.addEventListener('click', async () => {
            const copied = await copyTextToClipboard(correctText);
            showToast(copied ? 'Copied' : 'Copy failed');
          });
          card.append(copyBtn);
        } else {
          const note = document.createElement('p');
          note.className = 'question-note';
          note.textContent =
            'Correct answer is not exposed in Mentimeter public API for multiple-choice slides.';
          card.append(note);
        }
      }

      solutionEl.append(card);
    });
  }

  async function handleLookup(rawLink) {
    const sessionId = extractMentiSessionId(rawLink);
    if (!sessionId) {
      setStatusState('error', 'Please enter a valid menti.com link or session code.');
      return;
    }

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('mentiLink', rawLink.trim());
    window.history.replaceState({}, '', nextUrl);

    submitBtn.disabled = true;
    setStatusState('loading', `Fetching slide deck for session ${sessionId}...`);

    try {
      const parsed = await fetchSlideDeck(sessionId, { apiBase: activeApiBase });
      renderParsedDeck(parsed);
    } catch (error) {
      const msg =
        error?.message === 'INVALID_PAYLOAD'
          ? 'Unexpected response format from Mentimeter.'
          : error?.message || 'Failed to fetch quiz data.';
      setStatusState('error', msg);
    } finally {
      submitBtn.disabled = false;
      solutionEl.removeAttribute('aria-busy');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    handleLookup(mentiLinkInput.value);
  });

  saveApiBaseBtn.addEventListener('click', () => {
    try {
      const normalized = normalizeApiBase(apiBaseInput.value);
      activeApiBase = normalized;
      if (normalized) {
        safeStorageSet(API_BASE_STORAGE_KEY, normalized);
      } else {
        safeStorageRemove(API_BASE_STORAGE_KEY);
      }
      updateApiBaseDisplay();
      apiBaseFeedback.textContent = normalized
        ? `Saved API Host: ${normalized}`
        : 'Cleared custom API Host (same-origin mode).';
    } catch {
      apiBaseFeedback.textContent = 'Enter a valid http:// or https:// URL.';
    }
  });

  resetApiBaseBtn.addEventListener('click', () => {
    activeApiBase = defaultApiBase;
    safeStorageRemove(API_BASE_STORAGE_KEY);
    updateApiBaseDisplay();
    apiBaseFeedback.textContent = activeApiBase
      ? `Reset to default host: ${activeApiBase}.`
      : 'Reset to same-origin /api/slide-deck.';
  });

  parseRawJsonBtn.addEventListener('click', () => {
    const raw = rawJsonInput.value.trim();
    if (!raw) {
      setStatusState('error', 'Paste Mentimeter JSON first before parsing.');
      return;
    }
    try {
      const json = JSON.parse(raw);
      const parsed = parseSlideDeckPayload(json);
      renderParsedDeck(parsed);
    } catch {
      setStatusState('error', 'Invalid Mentimeter JSON payload.');
    }
  });

  if (safeStorageGet('hideNotice') === 'true') {
    noticeEl.hidden = true;
  }

  hideNoticeBtn.addEventListener('click', () => {
    noticeEl.hidden = true;
    safeStorageSet('hideNotice', 'true');
  });

  updateApiBaseDisplay();

  const initialLink = new URLSearchParams(window.location.search).get('mentiLink');
  if (initialLink) {
    mentiLinkInput.value = initialLink;
    handleLookup(initialLink);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initializeApp);
}
