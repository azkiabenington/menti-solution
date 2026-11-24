# Mentimeter Quiz Solutions: Slide-Deck API Migration & Hybrid Hosting Design

**Date:** 2026-11-24
**Status:** Draft for review

## 1. Problem Statement & Root Causes

Active Mentimeter links such as `https://www.menti.com/al742i1zxz7c` currently fail across both the web interface (`index.html` / `index.js`) and the userscript (`script.user.js`) due to three verified breaks:

1. **Dead CORS proxy & direct CORS blocking:** `index.js` routes API calls through `https://api.allorigins.win/raw?url=...`, which currently times out with 0 bytes received. Calling `api.mentimeter.com` or `www.menti.com/core/...` directly from another browser origin (such as `github.io` or `localhost`) returns `HTTP 403 Forbidden (Cross-Origin Request Blocked)`.
2. **Deprecated endpoints & changed payload schema:**
   - `/series/{id}` (`index.js` advanced mode) and `/core/audience/series/{sessionId}/series-id` (`script.user.js`) now return `HTTP 404 Not Found`.
   - `GET /audience/slide-deck/{sessionId}` returns `HTTP 200 OK` (from server-side or same-origin on `www.menti.com`), but uses `data.slide_deck.slides` (`static_content.type`, `interactive_contents[].title`, `interactive_contents[].choices[].title`) instead of `data.series.questions`. Because `index.js` checks `data.series === undefined`, valid responses always fail.
   - `index.js` also contains two client bugs: `DOMContentLoaded` registers two conflicting listeners (showing an error banner on initial page load), and `isValidSeriesId` calls non-existent `String.prototype.contains()`.
3. **API data limitation for multiple choice:** For `quiz-choice` slides, Mentimeter's public `slide-deck` response no longer includes a `correct_answer` flag on choice objects. For `quiz-open` (short answer) slides, accepted answers remain present in `interactive_contents[].choices[].title`.

## 2. Goals & Non-Goals

### Goals
- Support static deployment on `github.io` (GitHub Pages) paired with a zero-dependency Node.js proxy/host (`server.mjs`) that can run on `admin-adg` or locally.
- Support direct, zero-backend execution on `https://www.menti.com/*` via an updated, self-contained `script.user.js`.
- Support offline/static JSON inspection via a manual JSON paste fallback when no proxy backend is configured.
- Render `quiz-open` answers safely (`textContent`, never `innerHTML`) with accessible Copy buttons, and render `quiz-choice` questions/options transparently (marking `correct_answer` if ever present, otherwise stating clearly that Mentimeter's public API does not expose it).

### Non-Goals
- Bypassing Mentimeter access controls or probing undocumented private/presenter-only endpoints to extract hidden `quiz-choice` answers.
- Adding third-party npm dependencies or build bundlers.

## 3. Architecture & Data Flow

```
[Static Web on github.io] --(GET /api/slide-deck?sessionId=...)--> [server.mjs on admin-adg / localhost]
         |                                                                    |
         | (optional Paste JSON fallback)                                     v
         v                                                  https://api.mentimeter.com/audience/slide-deck/:id
  [parser.js (ESM)]

[Tampermonkey on www.menti.com/*] --(same-origin GET)--> https://www.menti.com/core/audience/slide-deck/:id
         |
         v
  [Self-contained parser + overlay in script.user.js]
```

### Component Breakdown

1. **`parser.js` (Shared Pure ES Module)**
   - `isValidSessionId(sessionId)`: validates `typeof sessionId === 'string'` and `/^[a-z0-9_-]{4,64}$/i`.
   - `extractMentiSessionId(input)`: accepts full `menti.com` URLs (with or without `https://`, `www.`, trailing `/`, query parameters, or hash) or a bare valid session code, returning the normalized session ID string or `null`.
   - `parseSlideDeckPayload(payload)`:
     - When `payload?.slide_deck?.slides` is an array: extracts `deckTitle` (`payload.slide_deck.name`), `totalSlides`, and normalized question items for `quiz-open` and `quiz-choice` (skipping `free-text`, `leaderboard`, and non-question slides).
       - `quiz-open`: `{ id, type: 'quiz-open', question, answers: string[] }` drawn from `interactive_contents[].choices[].title`.
       - `quiz-choice`: `{ id, type: 'quiz-choice', question, options: { title: string, isCorrect: boolean }[], hasCorrectAnswer: boolean }`.
     - When `payload?.series?.questions` is an array (legacy format): normalizes `quiz_open` and `quiz` into the same output shape so legacy pasted payloads continue working.
     - Throws an `Error('INVALID_PAYLOAD')` when neither structure exists.

2. **`server.mjs` (Zero-Dependency Node.js HTTP Server & CORS API Proxy)**
   - Uses built-in `node:http`, `node:fs/promises`, `node:path`, and `fetch`.
   - Environment configuration:
     - `HOST` (default `'127.0.0.1'`, set to `'0.0.0.0'` on `admin-adg`).
     - `PORT` (default `3000`).
     - `ALLOWED_ORIGINS` (default `'*'`, or comma-separated origin allowlist such as `https://username.github.io` for stricter scoping).
     - `UPSTREAM_TIMEOUT_MS` (default `10000`).
   - Exports `createServerHandler({ fetchFn, rootDir, allowedOrigins, timeoutMs })` so HTTP behavior is fully testable without network calls.
   - Endpoints:
     - `GET /health` -> `200` `{ "ok": true }`.
     - `OPTIONS /api/slide-deck` -> `204` with CORS headers (`Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Allow-Headers: Content-Type`).
     - `GET /api/slide-deck?sessionId=<id>`:
       - Validates `sessionId` via `isValidSessionId`; invalid or missing ID returns `400` `{ error: 'INVALID_SESSION_ID', message: ... }`.
       - Requests `https://api.mentimeter.com/audience/slide-deck/${encodeURIComponent(sessionId)}` with `Accept: application/json` and `AbortSignal.timeout(timeoutMs)`.
       - Maps upstream `200` JSON directly with `Cache-Control: no-store` and CORS headers.
       - Maps upstream `404` to `404` `{ error: 'QUIZ_NOT_FOUND', message: ... }`.
       - Maps timeouts (`TimeoutError`/`AbortError`) to `504` and other upstream/parse errors to `502`.
     - Static file allowlist serving only: `/`, `/index.html`, `/index.js`, `/index.css`, `/parser.js`, `/config.js`, `/script.user.js`, `/pics/github-mark.svg`, `/pics/github-mark-white.svg`. Any other path returns `404`.

3. **`config.js` (Static Hosting Endpoint Configuration)**
   - Exports `DEFAULT_API_BASE = ''` (empty string means same-origin `/api/slide-deck`, ideal when opened directly from `server.mjs`).
   - Allows editing `DEFAULT_API_BASE` directly before pushing to `github.io` (for example `'https://menti-api.your-domain.com'`), or overriding via `?apiBase=...` query param / UI Settings stored in `localStorage` (`menti_api_base`), validated to `http:` or `https:` URLs only.

4. **Web UI (`index.html`, `index.css`, `index.js`)**
   - Loaded as `<script type="module" src="./index.js">`.
   - Removes the broken `seriesValue` / `getAnswersAdvanced` flow and the conflicting duplicate `DOMContentLoaded` listener.
   - Provides:
     - Primary form with visible `<label for="mentiLink">`, `<input id="mentiLink">`, and `<button id="getAnswers" type="submit">`.
     - Native `<details>` disclosure for **Backend API Host** (shows resolved API URL and lets `github.io` users save/clear their `admin-adg` host URL without editing code).
     - Native `<details>` disclosure for **Paste JSON Payload** (parses raw Mentimeter JSON offline/client-side via `parseSlideDeckPayload`).
     - Distinct UI states: **Empty** (neutral prompt on load), **Loading** (`aria-busy="true"`, disabled submit button), **Error** (clear cause, including guidance if opened on static `github.io` or `file://` without a configured API host), and **Success** (deck title, summary counts, and question cards).
   - Safe rendering: builds DOM elements with `document.createElement` and sets all dynamic strings via `textContent`.
   - Accessible Copy buttons: native `<button type="button" class="copy-button">` inside each `quiz-open` card (plus any `quiz-choice` with `isCorrect`), writing via `navigator.clipboard.writeText` with a `role="status"` live announcement.

5. **Userscript (`script.user.js`)**
   - Self-contained Tampermonkey/Violentmonkey script (`@version 2.0`, `@match https://www.menti.com/*`, `@grant none`).
   - Detects initial load and SPA navigation (`pushState`, `replaceState`, `popstate`) on `www.menti.com` to resolve the current `sessionId` (ignoring non-quiz paths if `/core/audience/slide-deck/{id}` returns `404`).
   - Fetches same-origin `https://www.menti.com/core/audience/slide-deck/${sessionId}` with `credentials: 'include'`.
   - Renders a collapsible floating drawer/panel directly on `menti.com` using `textContent` and accessible `<button type="button">` controls (Refresh, Toggle/Close, Copy answer), with zero reliance on external servers or dead `github.io` query tabs.

6. **Project Metadata & Docs (`package.json`, `README.md`)**
   - `package.json`: `"type": "module"`, `"scripts": { "start": "node server.mjs", "test": "node --test" }`, zero runtime dependencies.
   - `README.md`: concise usage guide for local Node.js, `github.io` + `admin-adg` host setup, and userscript installation.

## 4. Error Handling & Security Guardrails

- **No open proxy:** `server.mjs` only fetches `https://api.mentimeter.com/audience/slide-deck/${sessionId}` after strict regex validation of `sessionId`.
- **No XSS from quiz content:** All untrusted strings from Mentimeter (`name`, `title`, `choices`) are inserted strictly with `textContent`, never `innerHTML`.
- **Static path allowlist:** `server.mjs` maps URL paths through an explicit lookup map rather than joining arbitrary URL paths to disk paths.
- **API base URL validation:** Client `apiBase` override accepts only valid `http:` or `https:` origins and trims trailing slashes.

## 5. Verification Strategy (TDD)

- **`test/parser.test.mjs` (`node:test` + `node:assert/strict`):**
  - Session ID extraction across full URLs, trailing slashes, query parameters, bare codes, and invalid inputs.
  - Parsing the `slide_deck` payload schema (modeled directly after `al742i1zxz7c`: `free-text`, `quiz-choice` without `correct_answer`, `quiz-open` with `Lovelace`, `leaderboard`), `quiz-choice` with `correct_answer: true`, legacy `series` payloads, and malformed payloads.
- **`test/server.test.mjs` (`node:test` + `node:assert/strict`):**
  - `GET /health` returns `200`.
  - Static route allowlist serves valid project files and returns `404` for traversal/disallowed files (`/etc/passwd`, `/server.mjs`, `/../secret`).
  - `GET /api/slide-deck` rejects invalid `sessionId` (`400`), handles CORS `OPTIONS` preflight, and maps mocked upstream `200`, `404`, `500`, and timeout (`504`) responses cleanly.
- **Live & Browser End-to-End Check:**
  - Start `server.mjs` locally and verify `GET /api/slide-deck?sessionId=al742i1zxz7c` returns `200` and parses `"Lovelace"` plus the 7 `quiz-choice` slides.
  - Open the page in a real browser (and mobile viewport), verify console has zero errors, exercise loading/error/success states, keyboard navigation (`Tab`/`Enter`), Copy button, and Paste JSON fallback.
