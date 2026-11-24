import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'script.user.js',
);

function createMockDom(initialHref) {
  let innerHtmlAssignments = 0;

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.style = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this._textContent = '';
      this.id = '';
      this.type = '';
      this.hidden = false;
    }

    get textContent() {
      if (this.children.length === 0) return this._textContent;
      return this._textContent + this.children.map((c) => c.textContent).join('\n');
    }

    set textContent(value) {
      this._textContent = String(value ?? '');
      this.children = [];
    }

    set innerHTML(_value) {
      innerHtmlAssignments += 1;
    }

    get innerHTML() {
      return '';
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'id') this.id = String(value);
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    append(...nodes) {
      for (const node of nodes) {
        if (typeof node === 'string') {
          const textNode = new FakeElement('#text');
          textNode._textContent = node;
          this.children.push(textNode);
        } else if (node) {
          node.parentNode = this;
          this.children.push(node);
        }
      }
    }

    appendChild(node) {
      this.append(node);
      return node;
    }

    replaceChildren(...nodes) {
      this.children = [];
      this._textContent = '';
      this.append(...nodes);
    }

    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      }
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }

    querySelector(selector) {
      const idMatch = selector.startsWith('#') ? selector.slice(1) : null;
      for (const child of this.children) {
        if (idMatch && child.id === idMatch) return child;
        if (!idMatch && child.tagName === selector.toUpperCase()) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }

    querySelectorAll(selector) {
      const matches = [];
      for (const child of this.children) {
        if (child.tagName === selector.toUpperCase()) matches.push(child);
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    }
  }

  const body = new FakeElement('body');
  const windowListeners = new Map();
  const location = { href: initialHref };
  const history = {
    pushState(_state, _title, url) {
      if (url) location.href = new URL(url, location.href).href;
    },
    replaceState(_state, _title, url) {
      if (url) location.href = new URL(url, location.href).href;
    },
  };

  const document = {
    body,
    readyState: 'complete',
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => body.querySelector(`#${id}`),
    addEventListener: () => {},
  };

  const windowObj = {
    location,
    history,
    document,
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    open() {
      throw new Error('window.open must not be called');
    },
  };

  return {
    body,
    document,
    history,
    location,
    windowObj,
    getInnerHtmlAssignments: () => innerHtmlAssignments,
  };
}

describe('script.user.js', () => {
  it('uses updated v2.0 userscript headers without legacy series/external tab dependencies', async () => {
    const source = await fs.readFile(SCRIPT_PATH, 'utf8');
    assert.match(source, /@version\s+2\.0/);
    assert.match(source, /@match\s+https:\/\/www\.menti\.com\/\*/);
    assert.match(source, /@grant\s+none/);
    assert.doesNotMatch(source, /\/core\/audience\/series\//);
    assert.doesNotMatch(source, /an0n-00\.github\.io\/mentimeter-quiz-solutions\/\?seriesId=/);
  });

  it('fetches same-origin /core/audience/slide-deck and renders quiz-open and quiz-choice safely via textContent', async () => {
    const source = await fs.readFile(SCRIPT_PATH, 'utf8');
    const dom = createMockDom('https://www.menti.com/al742i1zxz7c');
    const fetchCalls = [];

    const mockFetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            slide_deck: {
              name: 'Kuis Sejarah Komputer',
              slides: [
                {
                  slide_public_key: 'q1',
                  static_content: { type: 'quiz-choice' },
                  interactive_contents: [
                    {
                      title: 'Alat hitung apakah?',
                      choices: [{ title: 'Sempoa' }, { title: 'Astrolab' }],
                    },
                  ],
                },
                {
                  slide_public_key: 'q2',
                  static_content: { type: 'quiz-open' },
                  interactive_contents: [
                    {
                      title: 'Apa nama keluarga Ada?',
                      choices: [{ title: 'Lovelace' }],
                    },
                  ],
                },
              ],
            },
          };
        },
      };
    };

    const context = {
      window: dom.windowObj,
      document: dom.document,
      history: dom.history,
      location: dom.location,
      fetch: mockFetch,
      navigator: { clipboard: { writeText: async () => {} } },
      URL,
      setTimeout,
      clearTimeout,
      console,
    };

    vm.runInNewContext(source, context);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0].url,
      'https://www.menti.com/core/audience/slide-deck/al742i1zxz7c',
    );
    assert.equal(fetchCalls[0].options?.credentials, 'include');
    assert.equal(dom.getInnerHtmlAssignments(), 0);

    const renderedText = dom.body.textContent;
    assert.match(renderedText, /Kuis Sejarah Komputer/);
    assert.match(renderedText, /Lovelace/);
    assert.match(renderedText, /Sempoa/);
  });

  it('ignores non-quiz 404 routes and clears stale panel on SPA navigation to root', async () => {
    const source = await fs.readFile(SCRIPT_PATH, 'utf8');

    const nonQuizDom = createMockDom('https://www.menti.com/features');
    vm.runInNewContext(source, {
      window: nonQuizDom.windowObj,
      document: nonQuizDom.document,
      history: nonQuizDom.history,
      location: nonQuizDom.location,
      fetch: async () => ({ ok: false, status: 404, async json() { return {}; } }),
      navigator: { clipboard: { writeText: async () => {} } },
      URL,
      setTimeout,
      clearTimeout,
      console,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(nonQuizDom.body.querySelector('#menti-solutions-panel'), null);

    const spaDom = createMockDom('https://www.menti.com/al742i1zxz7c');
    vm.runInNewContext(source, {
      window: spaDom.windowObj,
      document: spaDom.document,
      history: spaDom.history,
      location: spaDom.location,
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            slide_deck: {
              name: 'Quiz A',
              slides: [
                {
                  slide_public_key: 'q1',
                  static_content: { type: 'quiz-open' },
                  interactive_contents: [{ title: 'Q1', choices: [{ title: 'Lovelace' }] }],
                },
              ],
            },
          };
        },
      }),
      navigator: { clipboard: { writeText: async () => {} } },
      URL,
      setTimeout,
      clearTimeout,
      console,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(spaDom.body.textContent, /Lovelace/);

    spaDom.history.pushState({}, '', '/');
    assert.equal(spaDom.body.querySelector('#menti-solutions-panel'), null);
  });

  it('enforces 44px minimum button tap targets and injects focus/hover/active styles', async () => {
    const source = await fs.readFile(SCRIPT_PATH, 'utf8');
    assert.match(source, /:focus-visible/);
    assert.match(source, /:hover/);
    assert.match(source, /:active/);

    const dom = createMockDom('https://www.menti.com/al742i1zxz7c');
    vm.runInNewContext(source, {
      window: dom.windowObj,
      document: dom.document,
      history: dom.history,
      location: dom.location,
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            slide_deck: {
              name: 'Quiz',
              slides: [
                {
                  slide_public_key: 'q1',
                  static_content: { type: 'quiz-open' },
                  interactive_contents: [{ title: 'Q', choices: [{ title: 'Ans' }] }],
                },
              ],
            },
          };
        },
      }),
      navigator: { clipboard: { writeText: async () => {} } },
      URL,
      setTimeout,
      clearTimeout,
      console,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const buttons = dom.body.querySelectorAll('button');
    assert.ok(buttons.length >= 4);
    for (const btn of buttons) {
      assert.equal(btn.style.minHeight, '44px');
      assert.equal(btn.style.minWidth, '44px');
    }
  });
});
