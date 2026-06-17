# AI Rules – Twitch Booster

## Tech Stack

- **Runtime:** Node.js (v18+)
- **Server Framework:** Express 4 (server.js)
- **Database:** SQLite via `better-sqlite3` (synchronous, file-based)
- **HTTP Client:** Axios (for SMMCost API calls)
- **Frontend:** Plain HTML + CSS (`public/index.html`) – **NOT** React, Vue, or any SPA framework
- **Frontend Styling:** Vanilla CSS using CSS custom properties (no Tailwind, no external CSS libraries)
- **Frontend JavaScript:** Plain vanilla JS (no TypeScript, no bundler)
- **Deployment:** PM2 process manager (`ecosystem.config.js`) behind Nginx reverse proxy

## Library & Architectural Rules

1. **No React or modern frontend framework.** The frontend is a single HTML file with embedded CSS/JS. Do not introduce React, Vue, Svelte, or any SPA framework.
2. **No Tailwind CSS or PostCSS.** All styling uses plain CSS. Keep using CSS custom properties in `:root` for theming.
3. **No TypeScript.** Use plain JavaScript for both server and client code.
4. **No bundlers.** No Webpack, Vite, esbuild, etc. The server serves static files from `public/`.
5. **Database remains SQLite via `better-sqlite3`.** Do not change to another database (PostgreSQL, MySQL, etc.) unless explicitly requested.
6. **SSE (Server-Sent Events) for real-time streaming.** Do not replace with WebSockets.
7. **No additional npm packages** unless absolutely necessary and agreed upon. Keep dependencies minimal: `express`, `axios`, `better-sqlite3`.
8. **All routes live in `server.js`.** Do not split into separate route files unless the file grows beyond 500 lines.
9. **History data is stored in `history.db` (auto-created).** Schema changes must be backward-compatible (use `IF NOT EXISTS` for new tables, add columns with `ALTER TABLE` when needed).
10. **Frontend API calls use `fetch()`.** Avoid XMLHttpRequest or other HTTP clients in the browser.