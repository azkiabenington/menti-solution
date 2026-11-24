# Mentimeter Slide-Deck Fix & Hybrid Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Mentimeter quiz parsing across the static `github.io` frontend, a zero-dependency Node.js proxy/host (`server.mjs` for `admin-adg` / local use), and the self-contained Tampermonkey userscript (`script.user.js`).

**Architecture:** Extract pure session-ID validation and `slide_deck` / legacy `series` normalization into `parser.js` (shared ES module), place a CORS-capable proxy/static server in `server.mjs` paired with `config.js`, update the web UI (`index.html`, `index.css`, `index.js`) with safe `textContent` rendering, accessible Copy buttons, and a Paste JSON fallback, and make `script.user.js` run self-contained same-origin on `https://www.menti.com/*`.

**Tech Stack:** Native ES Modules (JavaScript), Node.js v24 built-ins (`node:http`, `node:fs/promises`, `node:path`, `node:test`, `node:assert/strict`), vanilla HTML5/CSS3.

**Spec:** `docs/superpowers/specs/2026-11-24-mentimeter-slide-deck-design.md`

## Global Constraints

- Zero runtime npm dependencies and no build bundlers; use Node.js built-ins and native browser ES modules only.
- `server.mjs` reads `HOST` (default `'127.0.0.1'`), `PORT` (default `3000`), `ALLOWED_ORIGINS` (default `'*'`), and `UPSTREAM_TIMEOUT_MS` (default `10000`).
- `isValidSessionId` enforces `/^[a-z0-9_-]{4,64}$/i`; `server.mjs` upstream target is fixed strictly to `https://api.mentimeter.com/audience/slide-deck/${encodeURIComponent(sessionId)}`.
- Static file serving in `server.mjs` uses an explicit path allowlist (`/`, `/index.html`, `/index.js`, `/index.css`, `/parser.js`, `/config.js`, `/script.user.js`, `/pics/github-mark.svg`, `/pics/github-mark-white.svg`).
- Untrusted strings from Mentimeter (`name`, `title`, `choices`, `message`) must always be rendered with `textContent`, never `innerHTML`.
- `script.user.js` must remain a single self-contained file (`@version 2.0`, `@match https://www.menti.com/*`, `@grant none`) fetching same-origin `https://www.menti.com/core/audience/slide-deck/${sessionId}` with `credentials: 'include'`.

## Review Focus

- Bare `menti.com/...` URLs without protocol, trailing slashes, or `#`/`?` params must still extract the session ID, while unrelated domains (`https://evil.com/al742i1zxz7c`) must return `null` (covered in Task 1).
- Slides with missing `interactive_contents`, empty `choices`, or missing `interactive_contents[0].title` (falling back to `slide.title`) must normalize without throwing `TypeError` (covered in Task 1).
- Upstream non-JSON responses (e.g., HTML `502`/Cloudflare block) on `/api/slide-deck` must return clean JSON `502` instead of throwing an uncaught JSON parse crash (covered in Task 2).
- `normalizeApiBase` must reject non-`http:`/`https:` URLs (`javascript:...`, `ftp:...`) and strip trailing slashes, and `server.mjs` must never reflect untrusted origins when `ALLOWED_ORIGINS` is a fixed list (covered in Task 2).
- Opening `index.html` statically (`file://` or `github.io`) with `apiBase === ''` and receiving a `404` HTML page or CORS/network error must display actionable Backend Host / Paste JSON guidance rather than raw JSON parse errors (covered in Task 3).

---

### Task 1: Package Setup & Shared Parser (`parser.js`)

**Files:**
- Create: `package.json`
- Create: `parser.js`
- Test: `test/parser.test.mjs`

**Interfaces:**
- Consumes: none
- Produces (`parser.js`):
  - `isValidSessionId(sessionId)` -> `boolean`
  - `extractMentiSessionId(input)` -> `string | null`
  - `parseSlideDeckPayload(payload)` -> `{ deckTitle: string, totalSlides: number, questions: Array<{ id: string, type: 'quiz-open', question: string, answers: string[] } | { id: string, type: 'quiz-choice', question: string, options: Array<{ title: string, isCorrect: boolean }>, hasCorrectAnswer: boolean }> }`

- [ ] **Step 1: Create `package.json` with ESM and test/start scripts**

```json
{
  "name": "mentimeter-quiz-solutions",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.mjs",
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Write failing parser tests in `test/parser.test.mjs`**

Include tests covering:
- `extract_session_id_variants`: full URL `https://www.menti.com/al742i1zxz7c`, trailing slash + query/hash `https://www.menti.com/al742i1zxz7c/?ref=1#top`, bare host `menti.com/al742i1zxz7c`, bare valid ID `al742i1zxz7c`, and rejections (`""`, `https://example.com/al742i1zxz7c`, `https://www.menti.com/`, `../../etc`).
- `parses_slide_deck_schema`: fixture matching `al742i1zxz7c` (`free-text`, `quiz-choice` with 4 choices and no `correct_answer`, `quiz-open` with choice `'Lovelace'`, `leaderboard`, plus a slide with empty `interactive_contents` and fallback `slide.title`). Assert `deckTitle`, `totalSlides`, `questions.length === 2`, `quiz-open` `answers: ['Lovelace']`, and `quiz-choice` `hasCorrectAnswer: false` with all 4 `options`.
- `parses_quiz_choice_when_correct_answer_present`: verifies `hasCorrectAnswer: true` and `isCorrect: true` on the matching option.
- `parses_legacy_series_payload`: verifies `{ series: { name, questions: [{ type: 'quiz_open', ... }, { type: 'quiz', ... }] } }` normalizes to the same output contract.
- `throws_on_invalid_payload`: asserts `parseSlideDeckPayload({})` and `parseSlideDeckPayload(null)` throw `/INVALID_PAYLOAD/`.

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/parser.test.mjs`
Expected: FAIL with module not found error for `../parser.js`.

- [ ] **Step 4: Implement `isValidSessionId`, `extractMentiSessionId`, and `parseSlideDeckPayload` in `parser.js`**

Write clean helper functions:
- `isValidSessionId(sessionId)`: `typeof sessionId === 'string' && /^[a-z0-9_-]{4,64}$/i.test(sessionId.trim())`.
- `extractMentiSessionId(input)`: trims input; if bare valid session ID, returns it; otherwise parses with `new URL(...)` (prepending `https://` when input starts with `menti.com/` or `www.menti.com/`), checks hostname is `menti.com` or ends with `.menti.com`, and returns the last non-empty path segment if `isValidSessionId` accepts it (otherwise `null`).
- `parseSlideDeckPayload(payload)`: handles `payload?.slide_deck?.slides` (reading `static_content?.type`, falling back `interactive_contents[0]?.title` to `slide.title`, filtering blank titles) and `payload?.series?.questions` (`quiz_open` and `quiz`); throws `new Error('INVALID_PAYLOAD')` if neither exists.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/parser.test.mjs`
Expected: PASS (all parser tests green).

- [ ] **Step 6: Commit**

```powershell
git add package.json parser.js test/parser.test.mjs; if ($LASTEXITCODE -eq 0) { git commit -m "feat: add shared Mentimeter slide-deck parser and tests" }
```

---

### Task 2: Zero-Dependency Node.js Proxy & Config (`config.js`, `server.mjs`)

**Files:**
- Create: `config.js`
- Create: `server.mjs`
- Test: `test/server.test.mjs`

**Interfaces:**
- Consumes: `isValidSessionId` from `./parser.js`
- Produces (`config.js`):
  - `DEFAULT_API_BASE` (`''`)
  - `normalizeApiBase(rawUrl)` -> `string` (returns normalized origin/base without trailing slash, `''` if empty, or throws `Error('INVALID_API_BASE')` if invalid/non-HTTP(S))
  - `resolveApiBase({ search, storage, defaultBase })` -> `string`
- Produces (`server.mjs`):
  - `createServerHandler({ fetchFn, rootDir, allowedOrigins, timeoutMs })` -> `(req, res) => Promise<void>`

- [ ] **Step 1: Write failing tests in `test/server.test.mjs`**

Start an ephemeral `http.createServer(createServerHandler(...))` on port `0` per test suite (closing in `after`) and cover:
- `config_normalization`: `normalizeApiBase('https://adg.example.com/')` -> `'https://adg.example.com'`, `normalizeApiBase('')` -> `''`, `normalizeApiBase('javascript:alert(1)')` throws `INVALID_API_BASE`, and `resolveApiBase` prioritizes `?apiBase=` over `storage` over `defaultBase`.
- `health_endpoint`: `GET /health` returns `200` with `{ ok: true }`.
- `static_allowlist_and_traversal`: `GET /` and `GET /parser.js` return `200` with `text/html` / `application/javascript`; `GET /server.mjs`, `GET /../package.json`, and `GET /docs/superpowers/specs/2026-11-24-mentimeter-slide-deck-design.md` return `404`.
- `api_slide_deck_validation_and_cors`: missing/invalid `sessionId` returns `400` `{ error: 'INVALID_SESSION_ID' }`; `OPTIONS /api/slide-deck` with allowed/disallowed origins tests exact CORS behavior (`Access-Control-Allow-Origin` present for allowed origin and omitted when `allowedOrigins: ['https://allowed.github.io']` receives `https://other.example`).
- `api_slide_deck_upstream_mapping`: mocked `fetchFn` tests:
  - `200` JSON -> returns `200` JSON with `Cache-Control: no-store` and verifies target URL `https://api.mentimeter.com/audience/slide-deck/al742i1zxz7c`.
  - `404` -> returns `404` `{ error: 'QUIZ_NOT_FOUND' }`.
  - `200` with non-JSON body (`'<html>Bad Gateway</html>'`) -> returns `502` `{ error: 'UPSTREAM_ERROR' }`.
  - `AbortError` / `TimeoutError` -> returns `504` `{ error: 'UPSTREAM_TIMEOUT' }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.mjs`
Expected: FAIL with module not found error for `../config.js` / `../server.mjs`.

- [ ] **Step 3: Implement `config.js` and `server.mjs`**

- In `config.js`: export `DEFAULT_API_BASE = ''`, `normalizeApiBase(rawUrl)`, and `resolveApiBase({ search = '', storage = null, defaultBase = DEFAULT_API_BASE } = {})`.
- In `server.mjs`:
  - Import `isValidSessionId` from `./parser.js`.
  - Define static allowlist map (`/` -> `index.html`, `/index.html`, `/index.js`, `/index.css`, `/parser.js`, `/config.js`, `/script.user.js`, `/pics/github-mark.svg`, `/pics/github-mark-white.svg`) with strict MIME types.
  - Export `createServerHandler({ fetchFn = globalThis.fetch, rootDir = __dirname, allowedOrigins = '*', timeoutMs = 10000 } = {})`.
  - Only call `server.listen(port, host)` when invoked directly (`process.argv[1]` matches `import.meta.filename` via `pathToFileURL`).

- [ ] **Step 4: Run test suite to verify Task 1 & Task 2 pass**

Run: `node --test`
Expected: PASS (all tests in `parser.test.mjs` and `server.test.mjs` green).

- [ ] **Step 5: Commit**

```powershell
git add config.js server.mjs test/server.test.mjs; if ($LASTEXITCODE -eq 0) { git commit -m "feat: add zero-dependency Node.js slide-deck proxy and static host" }
```

---

### Task 3: Accessible Web UI & Client Logic (`index.html`, `index.css`, `index.js`)

**Files:**
- Modify: `index.html:1-43`
- Modify: `index.css:1-215`
- Modify: `index.js:1-210`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `extractMentiSessionId`, `parseSlideDeckPayload` from `./parser.js`; `normalizeApiBase`, `resolveApiBase` from `./config.js`
- Produces (`index.js`):
  - `buildSlideDeckUrl(sessionId, apiBase)` -> `string`
  - `fetchSlideDeck(sessionId, { apiBase, fetchFn })` -> `Promise<object>` (throws typed errors with `.code`: `'NOT_FOUND'`, `'STATIC_CORS_HINT'`, `'UPSTREAM_ERROR'`, `'INVALID_RESPONSE'`)
  - `classifyFetchFailure(status, contentType, apiBase)` -> `{ code: string, message: string }`

- [ ] **Step 1: Write failing client helper tests in `test/ui.test.mjs`**

Test pure exported helpers from `index.js` (guarded so `index.js` only attaches DOM listeners when `typeof document !== 'undefined'`):
- `build_slide_deck_url`: `buildSlideDeckUrl('al742i1zxz7c', '')` -> `'/api/slide-deck?sessionId=al742i1zxz7c'`; `buildSlideDeckUrl('al742i1zxz7c', 'https://adg.example.com')` -> `'https://adg.example.com/api/slide-deck?sessionId=al742i1zxz7c'`.
- `classify_static_404_html_hint`: when `apiBase === ''` and status `404` with `contentType: 'text/html'`, returns `{ code: 'STATIC_CORS_HINT', ... }` instructing user to configure the Backend API Host or use Paste JSON.
- `fetch_slide_deck_parses_and_handles_errors`: verifies `200` JSON resolves parsed data, `404` JSON `{ error: 'QUIZ_NOT_FOUND' }` throws `.code === 'NOT_FOUND'`, and network failure with `apiBase === ''` throws `.code === 'STATIC_CORS_HINT'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui.test.mjs`
Expected: FAIL because `index.js` references `document` at top level and does not export `buildSlideDeckUrl` / `fetchSlideDeck`.

- [ ] **Step 3: Update `index.html`, `index.css`, and `index.js`**

- In `index.html`:
  - Load `<script type="module" src="./index.js"></script>`.
  - Keep existing header/footer identity; replace `seriesValue` / `getAnswersAdvanced` with visible `<label for="mentiLink">`, `<input type="text" id="mentiLink" ...>`, `<button id="getAnswers" type="submit">Get Answers</button>`, two native `<details>` disclosures (**Backend API Host** with `<label for="apiBaseInput">` + Save/Reset buttons, and **Paste JSON Payload** with `<label for="rawJsonInput">` + Parse button), a `role="status"` live region (`#statusToast`), and `#solution` output region.
  - Update `#notice` copy honestly: explain supported `quiz-open` answers, `quiz-choice` option listing (public API omits `correct_answer`), and same-origin Tampermonkey userscript option.
- In `index.css`:
  - Preserve dark theme palette (`#121212`, `#1f1f1f`, `#2c2c2c`, `#6200ea`, `#bb86fc`) while fixing mobile responsiveness (no fixed `left: 46.5%` overflow on `.dropdown`, `max-width` / `width: min(100%, 720px)` instead of cramped `70%` on mobile, visible `:focus-visible` outlines, `cursor: pointer` on buttons, >= 44px touch targets on buttons, high contrast error/status text >= 4.5:1, and `prefers-reduced-motion: reduce` support).
- In `index.js`:
  - Export `buildSlideDeckUrl`, `classifyFetchFailure`, `fetchSlideDeck` cleanly, and initialize DOM wiring only when `typeof document !== 'undefined'`.
  - Remove duplicate `DOMContentLoaded` listener; initialize empty state (`'Enter a Mentimeter link above to inspect available answers.'`), prefill resolved `apiBase`, and handle `?mentiLink=...`.
  - Render question cards strictly via `document.createElement` + `textContent`:
    - `quiz-open`: question `<h3>`, answer list, and native `<button type="button" class="copy-button">` using `navigator.clipboard.writeText` (with status announcement in `#statusToast`).
    - `quiz-choice`: question `<h3>`, `<ul>` options (marking any option with `isCorrect === true` with a visible `[Correct]` badge if present), plus an explicit note when `hasCorrectAnswer` is `false`.

- [ ] **Step 4: Run full test suite to verify it passes**

Run: `node --test`
Expected: PASS (all tests in `parser.test.mjs`, `server.test.mjs`, and `ui.test.mjs` green).

- [ ] **Step 5: Commit**

```powershell
git add index.html index.css index.js test/ui.test.mjs; if ($LASTEXITCODE -eq 0) { git commit -m "feat: update web UI for slide-deck schema, safe DOM rendering, and API host config" }
```

---

### Task 4: Self-Contained Userscript (`script.user.js`) & Documentation (`README.md`)

**Files:**
- Modify: `script.user.js:1-93`
- Modify: `README.md:1-39`
- Test: `test/userscript.test.mjs`

**Interfaces:**
- Consumes: none at runtime (self-contained IIFE for Tampermonkey/Violentmonkey); logic matches `parser.js` contract.
- Produces: standalone `script.user.js` (`@version 2.0`)

- [ ] **Step 1: Write failing userscript verification test in `test/userscript.test.mjs`**

Verify via `vm` / script evaluation against a mock browser environment (`window`, `document`, `history`, `fetch`) OR parse & test the userscript's embedded helper functions / metadata:
- Header checks: `@version 2.0`, `@match https://www.menti.com/*`, `@grant none`, zero references to deprecated `/core/audience/series/` or `an0n-00.github.io` tab opening.
- Behavior test using `vm.runInNewContext` with mocked `location.href = 'https://www.menti.com/al742i1zxz7c'`, mocked `fetch` asserting request URL `https://www.menti.com/core/audience/slide-deck/al742i1zxz7c` (`credentials: 'include'`), and verifying the injected panel renders `'Lovelace'` without using `innerHTML` for API data!

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/userscript.test.mjs`
Expected: FAIL because `script.user.js` still requests `/core/audience/series/.../series-id` and opens `an0n-00.github.io`.

- [ ] **Step 3: Implement updated `script.user.js` and `README.md`**

- In `script.user.js`:
  - Bump `@version` to `2.0`.
  - Implement self-contained `isValidSessionId`, `extractSessionId`, and `parseSlideDeck` matching `parser.js`.
  - Fetch `https://www.menti.com/core/audience/slide-deck/${encodeURIComponent(sessionId)}` with `credentials: 'include'` and `Accept: application/json`.
  - Watch SPA URL changes (`history.pushState`, `history.replaceState`, `popstate`) so navigating between slides/sessions updates the panel cleanly.
  - Render collapsible floating panel using `document.createElement` and `textContent` only (with Refresh, Collapse/Close, and Copy `<button type="button">` controls).
- In `README.md`:
  - Update instructions for: (1) running locally with `npm start` (`node server.mjs`), (2) deploying static frontend to `github.io` + hosting `server.mjs` on `admin-adg` (`HOST=0.0.0.0 PORT=3000 ALLOWED_ORIGINS=https://<user>.github.io node server.mjs`), (3) installing `script.user.js` directly, and (4) documenting Mentimeter's `quiz-open` vs `quiz-choice` API behavior accurately.

- [ ] **Step 4: Run full test suite & live integration smoke check**

Run: `node --test`
Expected: PASS (all unit/integration tests green).

- [ ] **Step 5: Live verification against `al742i1zxz7c` & browser click-through**

- Start `server.mjs` on an available local port, query `GET /api/slide-deck?sessionId=al742i1zxz7c`, verify `200 OK` JSON contains `slide_deck` and `'Lovelace'`.
- Open the running app in a headless/real browser (desktop + 375px mobile viewport), check console has 0 errors, test submitting `https://www.menti.com/al742i1zxz7c`, test Copy button, test Backend API Host disclosure, test Paste JSON disclosure, and perform the **Antislop Mode 2 (`after`) Audit + Delivery Gate**.

- [ ] **Step 6: Commit**

```powershell
git add script.user.js README.md test/userscript.test.mjs; if ($LASTEXITCODE -eq 0) { git commit -m "feat: update userscript for same-origin slide-deck API and update README" }
```
