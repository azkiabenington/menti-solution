// ==UserScript==
// @name        Mentimeter Quiz Solution Userscript
// @namespace   https://github.com/an0n-00/mentimeter-quiz-solutions
// @match       https://www.menti.com/*
// @grant       none
// @version     2.0
// @author      An0n-00
// @description Inspect public Mentimeter slide-deck questions and short-answer solutions directly on menti.com
// @license     CC BY-NC-SA 4.0
// @updateURL   https://an0n-00.github.io/mentimeter-quiz-solutions/script.user.js
// @downloadURL https://an0n-00.github.io/mentimeter-quiz-solutions/script.user.js
// @supportURL  https://github.com/An0n-00/mentimeter-quiz-solutions/issues
// @icon        https://an0n-00.github.io/mentimeter-quiz-solutions/pics/github-mark-white.svg
// ==/UserScript==

(() => {
  const PANEL_ID = 'menti-solutions-panel';
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

  function parseSlideDeck(payload) {
    const slides = payload?.slide_deck?.slides;
    if (!Array.isArray(slides)) {
      throw new Error('Unexpected Mentimeter slide-deck response format.');
    }

    const questions = [];
    for (let i = 0; i < slides.length; i += 1) {
      const slide = slides[i];
      const slideType = slide?.static_content?.type;
      if (slideType !== 'quiz-open' && slideType !== 'quiz-choice') continue;

      const contents = Array.isArray(slide.interactive_contents) ? slide.interactive_contents : [];
      const primary = contents[0];
      const question = nonEmptyText(primary?.title) || nonEmptyText(slide?.title);
      const choices = contents.flatMap((item) => (Array.isArray(item?.choices) ? item.choices : []));

      if (slideType === 'quiz-open') {
        questions.push({
          type: 'quiz-open',
          question,
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
          type: 'quiz-choice',
          question,
          options,
          hasCorrectAnswer: options.some((o) => o.isCorrect),
        });
      }
    }

    return {
      deckTitle: nonEmptyText(payload.slide_deck.name),
      totalSlides: slides.length,
      questions,
    };
  }

  function makeButton(label, onClick, isSecondary = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.padding = '6px 10px';
    btn.style.minHeight = '32px';
    btn.style.borderRadius = '6px';
    btn.style.border = isSecondary ? '1px solid #555555' : 'none';
    btn.style.backgroundColor = isSecondary ? '#2c2c2c' : '#6200ea';
    btn.style.color = '#ffffff';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '12px';
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
    panel.style.width = 'min(380px, calc(100vw - 24px))';
    panel.style.maxHeight = '75vh';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.backgroundColor = '#18181b';
    panel.style.color = '#f4f4f5';
    panel.style.border = '1px solid #6200ea';
    panel.style.borderRadius = '10px';
    panel.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.55)';
    panel.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    panel.style.fontSize = '14px';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.gap = '8px';
    header.style.padding = '10px 12px';
    header.style.borderBottom = '1px solid #2e2e32';

    const title = document.createElement('strong');
    title.textContent = 'Menti Solutions';
    title.style.color = '#bb86fc';

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.gap = '6px';

    const refreshBtn = makeButton('Refresh', () => loadSession(true), true);
    toggleBtn = makeButton('Hide', () => {
      collapsed = !collapsed;
      bodyEl.hidden = collapsed;
      toggleBtn.textContent = collapsed ? 'Show' : 'Hide';
    }, true);
    const closeBtn = makeButton('Close', () => panel.remove(), true);

    controls.append(refreshBtn, toggleBtn, closeBtn);
    header.append(title, controls);

    statusEl = document.createElement('p');
    statusEl.setAttribute('role', 'status');
    statusEl.style.margin = '0';
    statusEl.style.padding = '8px 12px 0';
    statusEl.style.fontSize = '12px';
    statusEl.style.color = '#d4d4d8';

    bodyEl = document.createElement('div');
    bodyEl.style.overflowY = 'auto';
    bodyEl.style.padding = '10px 12px 12px';
    bodyEl.style.display = 'flex';
    bodyEl.style.flexDirection = 'column';
    bodyEl.style.gap = '10px';

    panel.append(header, statusEl, bodyEl);
    document.body.appendChild(panel);
    return panel;
  }

  function renderResults(parsed) {
    ensurePanel();
    statusEl.textContent = `${parsed.deckTitle || 'Mentimeter Quiz'} (${parsed.questions.length} question(s))`;
    bodyEl.replaceChildren();

    if (parsed.questions.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No quiz questions found in this slide deck.';
      empty.style.margin = '0';
      bodyEl.appendChild(empty);
      return;
    }

    parsed.questions.forEach((item, index) => {
      const card = document.createElement('div');
      card.style.backgroundColor = '#27272a';
      card.style.borderRadius = '8px';
      card.style.padding = '10px';

      const qTitle = document.createElement('div');
      qTitle.textContent = `${index + 1}. ${item.question || 'Untitled question'}`;
      qTitle.style.fontWeight = '600';
      qTitle.style.marginBottom = '6px';
      qTitle.style.color = '#e4e4e7';
      card.appendChild(qTitle);

      if (item.type === 'quiz-open') {
        item.answers.forEach((ans) => {
          const row = document.createElement('div');
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.justifyContent = 'space-between';
          row.style.gap = '8px';
          row.style.marginTop = '4px';

          const ansSpan = document.createElement('span');
          ansSpan.textContent = `Answer: ${ans}`;
          ansSpan.style.color = '#86fcc1';
          ansSpan.style.fontWeight = '700';

          const copyBtn = makeButton('Copy', async () => {
            try {
              await navigator.clipboard.writeText(ans);
              copyBtn.textContent = 'Copied';
              setTimeout(() => {
                copyBtn.textContent = 'Copy';
              }, 1500);
            } catch {
              copyBtn.textContent = 'Failed';
            }
          });

          row.append(ansSpan, copyBtn);
          card.appendChild(row);
        });
      } else {
        const list = document.createElement('ul');
        list.style.margin = '4px 0 0 18px';
        list.style.padding = '0';

        item.options.forEach((opt) => {
          const li = document.createElement('li');
          li.textContent = opt.isCorrect ? `${opt.title} [Correct]` : opt.title;
          if (opt.isCorrect) li.style.color = '#86fcc1';
          list.appendChild(li);
        });
        card.appendChild(list);

        if (!item.hasCorrectAnswer) {
          const note = document.createElement('p');
          note.textContent = 'Multiple-choice correct answers are not exposed in public API.';
          note.style.margin = '6px 0 0';
          note.style.fontSize = '12px';
          note.style.color = '#a1a1aa';
          card.appendChild(note);
        }
      }

      bodyEl.appendChild(card);
    });
  }

  async function loadSession(force = false) {
    const sessionId = extractSessionId(window.location.href);
    if (!sessionId) return;
    if (!force && sessionId === currentSessionId) return;
    currentSessionId = sessionId;

    ensurePanel();
    statusEl.textContent = `Loading slide deck ${sessionId}...`;

    try {
      const response = await fetch(
        `https://www.menti.com/core/audience/slide-deck/${encodeURIComponent(sessionId)}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: { accept: 'application/json' },
        },
      );

      if (!response.ok) {
        statusEl.textContent = `Could not load quiz (HTTP ${response.status}).`;
        return;
      }

      const data = await response.json();
      const parsed = parseSlideDeck(data);
      renderResults(parsed);
    } catch (error) {
      statusEl.textContent = error?.message || 'Failed to load slide deck.';
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
