// ==UserScript==
// @name        Mentimeter Quiz Solution Userscript
// @namespace   https://github.com/azkiabenington/menti-solution
// @match       https://www.menti.com/*
// @grant       none
// @version     2.0
// @author      An0n-00
// @description Inspect public Mentimeter slide-deck questions and short-answer solutions directly on menti.com
// @license     CC BY-NC-SA 4.0
// @updateURL   https://azkiabenington.github.io/menti-solution/script.user.js
// @downloadURL https://azkiabenington.github.io/menti-solution/script.user.js
// @supportURL  https://github.com/azkiabenington/menti-solution/issues
// @icon        https://azkiabenington.github.io/menti-solution/pics/github-mark-white.svg
// ==/UserScript==

(() => {
  const PANEL_ID = 'menti-solutions-panel';
  const STYLE_ID = 'menti-solutions-styles';
  const SOLVE_API_URL = 'https://admin-adg.tail595888.ts.net/api/solve';
  const SESSION_ID_RE = /^[a-z0-9_-]{4,64}$/i;

  function isValidSessionId(sessionId) {
    return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId.trim());
  }

  function extractSessionId(href) {
    try {
      const parsed = new URL(href);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const candidate = segments.at(-1);
      return isValidSessionId(candidate) ? candidate.trim() : null;
    } catch {
      return null;
    }
  }

  function nonEmptyText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeCountdown(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }

  function formatOptionLabel(index) {
    return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
  }

  function filterQuestions(questions, query = '') {
    if (!Array.isArray(questions)) return [];
    const q = String(query || '').trim().toLowerCase();
    if (!q) return questions;

    return questions.filter((item) => {
      if (String(item?.question || '').toLowerCase().includes(q)) return true;
      if (Array.isArray(item?.answers) && item.answers.some((ans) => String(ans).toLowerCase().includes(q))) {
        return true;
      }
      if (Array.isArray(item?.options) && item.options.some((opt) => String(opt?.title || '').toLowerCase().includes(q))) {
        return true;
      }
      return false;
    });
  }

  function parseSlideDeck(payload) {
    const slides = payload?.slide_deck?.slides;
    if (!Array.isArray(slides)) {
      throw new Error('Unexpected Mentimeter slide-deck response format.');
    }

    const rawCode = payload.slide_deck.participation_settings?.participation_code;
    const participationCode =
      rawCode !== null && rawCode !== undefined && String(rawCode).trim()
        ? String(rawCode).trim()
        : null;

    const questions = [];
    for (let i = 0; i < slides.length; i += 1) {
      const slide = slides[i];
      const slideType = slide?.static_content?.type;
      if (slideType !== 'quiz-open' && slideType !== 'quiz-choice') continue;

      const contents = Array.isArray(slide.interactive_contents) ? slide.interactive_contents : [];
      const primary = contents[0];
      const question = nonEmptyText(primary?.title) || nonEmptyText(slide?.title);
      const countdown = normalizeCountdown(primary?.countdown ?? slide?.countdown ?? null);
      const choices = contents.flatMap((item) => (Array.isArray(item?.choices) ? item.choices : []));
      const id = nonEmptyText(slide?.slide_public_key) || `slide-${i + 1}`;

      if (slideType === 'quiz-open') {
        questions.push({
          id,
          type: 'quiz-open',
          question,
          countdown,
          answers: choices.map((c) => nonEmptyText(c?.title)).filter(Boolean),
        });
      } else {
        const options = choices
          .map((c) => ({
            title: nonEmptyText(c?.title),
            isCorrect: c?.correct_answer === true,
          }))
          .filter((o) => o.title.length > 0);
        questions.push({
          id,
          type: 'quiz-choice',
          question,
          countdown,
          options,
          hasCorrectAnswer: options.some((o) => o.isCorrect),
        });
      }
    }

    return {
      deckTitle: nonEmptyText(payload.slide_deck.name),
      participationCode,
      totalSlides: slides.length,
      questions,
    };
  }

  function createScopedStyles() {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} .ms-btn {
        min-height: 44px;
        min-width: 44px;
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid transparent;
        background-color: #4f46e5;
        color: #ffffff;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: background-color 0.15s ease, transform 0.1s ease;
      }
      #${PANEL_ID} .ms-btn:hover {
        background-color: #6366f1;
      }
      #${PANEL_ID} .ms-btn:active {
        transform: translateY(1px);
      }
      #${PANEL_ID} .ms-btn:focus-visible,
      #${PANEL_ID} input:focus-visible {
        outline: 2px solid #a5b4fc;
        outline-offset: 2px;
      }
      #${PANEL_ID} .ms-btn-secondary {
        background-color: #242a38;
        border-color: #6b7892;
        color: #eef2f7;
      }
      #${PANEL_ID} .ms-btn-secondary:hover {
        background-color: #2f374a;
      }
      @media (prefers-reduced-motion: reduce) {
        #${PANEL_ID} .ms-btn {
          transition: none;
        }
      }
    `;
    return style;
  }

  function makeButton(label, onClick, isSecondary = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = isSecondary ? 'ms-btn ms-btn-secondary' : 'ms-btn';
    btn.textContent = label;
    btn.style.minHeight = '44px';
    btn.style.minWidth = '44px';
    btn.style.padding = '8px 12px';
    btn.style.borderRadius = '6px';
    btn.style.border = isSecondary ? '1px solid #6b7892' : '1px solid transparent';
    btn.style.backgroundColor = isSecondary ? '#242a38' : '#4f46e5';
    btn.style.color = isSecondary ? '#eef2f7' : '#ffffff';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '13px';
    btn.style.fontWeight = '600';
    btn.addEventListener('click', onClick);
    return btn;
  }

  let currentSessionId = null;
  let collapsed = false;
  let bodyEl = null;
  let statusEl = null;
  let toggleBtn = null;

  function ensurePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) return existing;

    const panel = document.createElement('aside');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-label', 'Mentimeter Quiz Solutions');
    panel.style.position = 'fixed';
    panel.style.top = '12px';
    panel.style.right = '12px';
    panel.style.zIndex = '2147483647';
    panel.style.width = 'min(400px, calc(100vw - 24px))';
    panel.style.maxHeight = '75vh';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.backgroundColor = '#1b1f2a';
    panel.style.color = '#eef2f7';
    panel.style.border = '1px solid #6b7892';
    panel.style.borderRadius = '10px';
    panel.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.45)';
    panel.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    panel.style.fontSize = '14px';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.flexWrap = 'wrap';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.gap = '8px';
    header.style.padding = '10px 12px';
    header.style.borderBottom = '1px solid #3b4459';

    const title = document.createElement('strong');
    title.textContent = 'Menti Solutions';
    title.style.color = '#a5b4fc';

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.flexWrap = 'wrap';
    controls.style.gap = '6px';

    const refreshBtn = makeButton('Refresh', () => loadSession(true), true);
    toggleBtn = makeButton('Hide', () => {
      collapsed = !collapsed;
      bodyEl.hidden = collapsed;
      toggleBtn.textContent = collapsed ? 'Show' : 'Hide';
    }, true);
    const closeBtn = makeButton('Close', () => clearPanel(), true);

    controls.append(refreshBtn, toggleBtn, closeBtn);
    header.append(title, controls);

    statusEl = document.createElement('p');
    statusEl.setAttribute('role', 'status');
    statusEl.style.margin = '0';
    statusEl.style.padding = '8px 12px 0';
    statusEl.style.fontSize = '12px';
    statusEl.style.color = '#b8c2d1';

    bodyEl = document.createElement('div');
    bodyEl.style.overflowY = 'auto';
    bodyEl.style.padding = '10px 12px 12px';
    bodyEl.style.display = 'flex';
    bodyEl.style.flexDirection = 'column';
    bodyEl.style.gap = '10px';

    panel.append(createScopedStyles(), header, statusEl, bodyEl);
    document.body.appendChild(panel);
    return panel;
  }

  function clearPanel() {
    document.getElementById(PANEL_ID)?.remove();
    currentSessionId = null;
    collapsed = false;
    bodyEl = null;
    statusEl = null;
    toggleBtn = null;
  }

  function formatQuestionPrompt(item, index = 0) {
    const lines = [`${index + 1}. ${nonEmptyText(item?.question) || 'Untitled question'}`];
    if (item?.type === 'quiz-open') {
      const answers = Array.isArray(item.answers) ? item.answers.filter(Boolean) : [];
      if (answers.length > 0) lines.push(`Accepted answer(s): ${answers.join(', ')}`);
    } else if (item?.type === 'quiz-choice') {
      const options = Array.isArray(item.options) ? item.options : [];
      options.forEach((opt, optIndex) => {
        const label = optIndex < 26 ? String.fromCharCode(65 + optIndex) : String(optIndex + 1);
        lines.push(opt.isCorrect ? `${label}. ${opt.title} [Correct]` : `${label}. ${opt.title}`);
      });
    }
    return lines.join('\n');
  }

  function formatDeckPrompt(parsed) {
    const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
    const body = questions.map((item, index) => formatQuestionPrompt(item, index)).join('\n\n');
    const title = nonEmptyText(parsed?.deckTitle);
    if (!title) return body;
    return body ? `Quiz: ${title}\n\n${body}` : `Quiz: ${title}`;
  }

  function makeCopyButton(label, getText, isSecondary = false) {
    const btn = makeButton(label, async () => {
      try {
        await navigator.clipboard.writeText(getText());
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.textContent = label;
        }, 1500);
      } catch {
        btn.textContent = 'Failed';
      }
    }, isSecondary);
    return btn;
  }

  function renderResults(parsed) {
    ensurePanel();
    const roomPart = parsed.participationCode ? ` | Room ${parsed.participationCode}` : '';
    const baseStatus = `${parsed.deckTitle || 'Mentimeter Quiz'} (${parsed.questions.length} question(s)${roomPart})`;
    statusEl.textContent = baseStatus;
    bodyEl.replaceChildren();

    if (parsed.questions.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No quiz questions found in this slide deck.';
      empty.style.margin = '0';
      bodyEl.appendChild(empty);
      return;
    }

    const aiSolutionsById = new Map();
    let currentQuery = '';

    const topActions = document.createElement('div');
    topActions.style.display = 'flex';
    topActions.style.flexWrap = 'wrap';
    topActions.style.gap = '8px';

    const solveAgyBtn = makeButton('Solve with AGY', async () => {
      solveAgyBtn.disabled = true;
      solveAgyBtn.textContent = 'Solving...';
      statusEl.textContent = `${baseStatus} | Solving with AGY (gemini-3.8-flash-low)...`;
      try {
        const res = await fetch(SOLVE_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            questions: parsed.questions.map((q) => ({
              id: q.id,
              type: q.type,
              question: q.question,
              options: Array.isArray(q.options) ? q.options.map((o) => o.title) : [],
            })),
          }),
        });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data?.solutions)) {
          throw new Error(data?.message || `HTTP ${res.status}`);
        }
        data.solutions.forEach((sol) => {
          if (sol?.id) aiSolutionsById.set(sol.id, sol);
        });
        renderCards(currentQuery);
        statusEl.textContent = `${baseStatus} | Solved via AGY (${data.model || 'gemini-3.8-flash-low'})`;
      } catch (err) {
        statusEl.textContent = `${baseStatus} | AGY solve error: ${err?.message || 'Failed'}`;
      } finally {
        solveAgyBtn.disabled = false;
        solveAgyBtn.textContent = 'Solve with AGY';
      }
    }, false);

    const copyAllBtn = makeCopyButton('Copy All Questions', () => formatDeckPrompt(parsed), true);
    topActions.append(solveAgyBtn, copyAllBtn);
    bodyEl.appendChild(topActions);

    let searchInput = null;
    if (parsed.questions.length > 1) {
      const searchBox = document.createElement('search');
      searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.placeholder = 'Filter questions, options, or answers...';
      searchInput.setAttribute('aria-label', 'Filter questions');
      searchInput.style.width = '100%';
      searchInput.style.minHeight = '44px';
      searchInput.style.padding = '8px 10px';
      searchInput.style.borderRadius = '6px';
      searchInput.style.border = '1px solid #6b7892';
      searchInput.style.backgroundColor = '#111827';
      searchInput.style.color = '#eef2f7';
      searchInput.style.fontSize = '13px';
      searchInput.style.boxSizing = 'border-box';
      searchInput.addEventListener('input', () => {
        currentQuery = searchInput.value;
        renderCards(currentQuery);
      });
      searchBox.appendChild(searchInput);
      bodyEl.appendChild(searchBox);
    }

    const cardsContainer = document.createElement('div');
    cardsContainer.style.display = 'flex';
    cardsContainer.style.flexDirection = 'column';
    cardsContainer.style.gap = '10px';
    bodyEl.appendChild(cardsContainer);

    function renderCards(query = '') {
      cardsContainer.replaceChildren();
      const filtered = filterQuestions(parsed.questions, query);

      if (filtered.length === 0) {
        const noMatch = document.createElement('p');
        noMatch.textContent = 'No questions match your filter.';
        noMatch.style.margin = '0';
        noMatch.style.fontSize = '13px';
        noMatch.style.color = '#b8c2d1';
        cardsContainer.appendChild(noMatch);
        return;
      }

      filtered.forEach((item) => {
        const index = parsed.questions.indexOf(item);
        const aiSol = aiSolutionsById.get(item.id);
        const card = document.createElement('div');
        card.style.backgroundColor = '#242a38';
        card.style.border = '1px solid #6b7892';
        card.style.borderRadius = '8px';
        card.style.padding = '12px';

        const qTitle = document.createElement('div');
        const timerText = item.countdown ? ` (${item.countdown}s)` : '';
        qTitle.textContent = `${index + 1}. ${item.question || 'Untitled question'}${timerText}`;
        qTitle.style.fontWeight = '600';
        qTitle.style.marginBottom = '8px';
        qTitle.style.color = '#a5b4fc';
        card.appendChild(qTitle);

        if (item.type === 'quiz-open') {
          if (item.answers.length === 0) {
            const note = document.createElement('p');
            note.textContent = 'No accepted short answer was returned for this slide.';
            note.style.margin = '4px 0 0';
            note.style.fontSize = '12px';
            note.style.color = '#b8c2d1';
            card.appendChild(note);
          } else {
            item.answers.forEach((ans) => {
              const row = document.createElement('div');
              row.style.display = 'flex';
              row.style.alignItems = 'center';
              row.style.justifyContent = 'space-between';
              row.style.gap = '8px';
              row.style.marginTop = '6px';

              const ansSpan = document.createElement('span');
              ansSpan.textContent = `Answer: ${ans}`;
              ansSpan.style.color = '#6ee7b7';
              ansSpan.style.fontWeight = '700';

              const copyBtn = makeCopyButton('Copy', () => ans);
              copyBtn.setAttribute('aria-label', `Copy answer ${ans}`);

              row.append(ansSpan, copyBtn);
              card.appendChild(row);
            });
          }
        } else {
          const list = document.createElement('ol');
          list.style.margin = '4px 0 0';
          list.style.padding = '0';
          list.style.listStyle = 'none';

          item.options.forEach((opt, optIndex) => {
            const li = document.createElement('li');
            const label = formatOptionLabel(optIndex);
            const isAiPick = aiSol?.choiceIndex === optIndex;
            if (opt.isCorrect) {
              li.textContent = `${label}. ${opt.title} [Correct]`;
              li.style.color = '#6ee7b7';
              li.style.fontWeight = '700';
            } else if (isAiPick) {
              li.textContent = `${label}. ${opt.title} [AI Pick]`;
              li.style.color = '#a5b4fc';
              li.style.fontWeight = '700';
            } else {
              li.textContent = `${label}. ${opt.title}`;
            }
            list.appendChild(li);
          });
          card.appendChild(list);

          if (aiSol) {
            const aiBox = document.createElement('div');
            aiBox.style.marginTop = '8px';
            aiBox.style.padding = '8px';
            aiBox.style.borderRadius = '6px';
            aiBox.style.backgroundColor = '#1b1f2a';
            aiBox.style.borderLeft = '3px solid #6366f1';

            const aiAns = document.createElement('div');
            aiAns.textContent = `AGY Answer: ${aiSol.answer}`;
            aiAns.style.color = '#6ee7b7';
            aiAns.style.fontWeight = '700';
            aiBox.appendChild(aiAns);

            if (aiSol.reason) {
              const aiReason = document.createElement('div');
              aiReason.textContent = aiSol.reason;
              aiReason.style.color = '#b8c2d1';
              aiReason.style.fontSize = '12px';
              aiReason.style.marginTop = '4px';
              aiBox.appendChild(aiReason);
            }
            card.appendChild(aiBox);
          } else if (!item.hasCorrectAnswer) {
            const note = document.createElement('p');
            note.textContent = 'Multiple-choice correct answers are not exposed in public API.';
            note.style.margin = '8px 0 0';
            note.style.fontSize = '12px';
            note.style.color = '#b8c2d1';
            card.appendChild(note);
          }

          const copyQuestionBtn = makeCopyButton(
            'Copy Question + Options',
            () => formatQuestionPrompt(item, index),
            true,
          );
          copyQuestionBtn.style.marginTop = '8px';
          copyQuestionBtn.setAttribute('aria-label', `Copy question ${index + 1} and options`);
          card.appendChild(copyQuestionBtn);
        }

        cardsContainer.appendChild(card);
      });
    }

    renderCards('');
  }

  async function loadSession(force = false) {
    const sessionId = extractSessionId(window.location.href);
    if (!sessionId) {
      clearPanel();
      return;
    }
    if (!force && sessionId === currentSessionId) return;
    currentSessionId = sessionId;

    const existingPanel = document.getElementById(PANEL_ID);
    if (existingPanel || force) {
      ensurePanel();
      statusEl.textContent = `Loading slide deck ${sessionId}...`;
      bodyEl.replaceChildren();
    }

    try {
      const response = await fetch(
        `https://www.menti.com/core/audience/slide-deck/${encodeURIComponent(sessionId)}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: { accept: 'application/json' },
        },
      );

      if (currentSessionId !== sessionId) return;

      if (!response.ok) {
        if (response.status === 404 && !force) {
          clearPanel();
          return;
        }
        ensurePanel();
        statusEl.textContent = `Could not load quiz (HTTP ${response.status}).`;
        bodyEl.replaceChildren();
        return;
      }

      const data = await response.json();
      if (currentSessionId !== sessionId) return;
      const parsed = parseSlideDeck(data);
      renderResults(parsed);
    } catch (error) {
      if (currentSessionId !== sessionId) return;
      if (document.getElementById(PANEL_ID) || force) {
        ensurePanel();
        statusEl.textContent = error?.message || 'Failed to load slide deck.';
        bodyEl.replaceChildren();
      }
    }
  }

  function wrapHistory(methodName) {
    const original = history[methodName];
    if (typeof original !== 'function') return;
    history[methodName] = function wrappedHistory(...args) {
      const result = original.apply(this, args);
      loadSession(false);
      return result;
    };
  }

  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', () => loadSession(false));

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => loadSession(false));
  } else {
    loadSession(false);
  }
})();
