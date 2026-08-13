# AGENTS.md — note-api

Obsidian plugin that exposes a localhost HTTP API (API-key protected) to view, create, edit and delete vault notes. **Backend for the note-tab Chrome extension.**

## Layout

- `main.ts` — plugin entry, HTTP server, API routes, settings tab
- `reminders.ts` — standalone reminders module (note-tab integration)
- `manifest.json` / `versions.json` / `styles.css` / `esbuild.config.mjs` / `eslint.config.mjs` / `tsconfig.json`
- `deploy.mjs` / `release.mjs` — maintainer scripts

## Commands

```bash
npm run dev      # esbuild watch -> dist/main.js
npm run build    # lint + tsc -noEmit -skipLibCheck + esbuild production
npm run lint     # eslint "**/*.{ts,tsx}"
npm run deploy   # build + copy to author's local vaults, then delete dist/
npm run release  # gh release create from manifest.json version
```

`build` enforces lint + tsc before bundling.

## Build

- esbuild, entry `main.ts`, format `cjs`, target `es2018`
- externals: `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`, Node builtins
- Copies `manifest.json`, `styles.css`, and `assets/` to `dist/`

## Architecture

- Exposes HTTP API on `127.0.0.1:27124` by default
- API key stored in plugin settings; default key matches note-tab's default
- Endpoints: `/api/status`, `/api/notes`, `/api/note/{path}`, `/api/search`, `/api/reminders`
- See `note-tab/AGENTS.md` for the client-side integration

## Lint

Strict typed rules: `no-explicit-any`, `no-unsafe-*`, `no-floating-promises`, `await-thenable`.

## Versioning

Keep `package.json`, `manifest.json`, and `versions.json` versions in sync. `release.mjs` reads version from `manifest.json`.

## Marketplace / Scorecard

Marketplace, manifest, and release conventions live in the parent `obsidian-plugins-parent/AGENTS.md`. Read it before touching `manifest.json`, release flow, or marketplace-facing code.