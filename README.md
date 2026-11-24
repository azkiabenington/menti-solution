# mentimeter-quiz-solutions

[![GitHub issues](https://img.shields.io/github/issues/An0n-00/mentimeter-quiz-solutions?label=Issues&color=red)](https://github.com/An0n-00/mentimeter-quiz-solutions/issues)  [![GitHub stars](https://img.shields.io/github/stars/An0n-00/mentimeter-quiz-solutions?label=Stars&color=yellow)](https://github.com/An0n-00/mentimeter-quiz-solutions/stargazers)   [![GitHub license](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-orange)](https://github.com/An0n-00/mentimeter-quiz-solutions/blob/main/LICENSE)

Inspect public Mentimeter `slide_deck` payloads across a local/self-hosted Node.js proxy, static GitHub Pages (`github.io`), and a same-origin browser userscript.

This project is a proof of concept for educational inspection only.

## Supported Mentimeter Behavior

Mentimeter migrated from `/series/{id}` to `/audience/slide-deck/{sessionId}` (`data.slide_deck.slides`) and enforces CORS against third-party browser origins (`403 Cross-Origin Request Blocked`):

- **Short-answer slides (`quiz-open`)**: accepted answers are returned in `interactive_contents[].choices[].title` and rendered with one-click copy buttons.
- **Multiple-choice slides (`quiz-choice`)**: Mentimeter no longer exposes `correct_answer` in the public `slide-deck` payload. The UI lists all choices and highlights answers only if a payload explicitly provides `correct_answer: true`.

## Option 1: Run Locally with Node.js (Zero Dependencies)

Requires Node.js 18+ (built-in `node:http` and `fetch`).

```bash
npm start
```

Open `http://127.0.0.1:3000/`, paste a Mentimeter link such as `https://www.menti.com/al742i1zxz7c`, and click **Get Answers**.

## Option 2: GitHub Pages (`github.io`) + Proxy Host (`admin-adg`)

Because GitHub Pages serves static files only and Mentimeter blocks cross-origin requests from `*.github.io`, pair your GitHub Pages frontend with `server.mjs` hosted on a machine you control (for example `admin-adg`):

1. Start the proxy on your host:
   ```bash
   HOST=0.0.0.0 PORT=3000 ALLOWED_ORIGINS=https://<your-user>.github.io node server.mjs
   ```
2. Either set `DEFAULT_API_BASE` in `config.js` before pushing to GitHub Pages, or open **Backend API Host** in the web UI (or pass `?apiBase=https://your-host`) to point the static page at your Node.js proxy.
3. If no backend host is available on a static page, expand **Paste JSON Payload** to parse a copied Mentimeter `slide-deck` JSON response directly in the browser.

## Option 3: Same-Origin Userscript (`script.user.js`)

Install `script.user.js` in [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/). When you visit `https://www.menti.com/<session>`, the userscript fetches `/core/audience/slide-deck/<session>` same-origin without needing an external proxy or Node.js host.

## Testing

```bash
npm test
```

## License

Licensed under [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](./LICENSE).
