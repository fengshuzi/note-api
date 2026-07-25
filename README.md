# Note API

Expose a localhost HTTP API (API-key protected) to view, create, edit and delete vault notes — so external tools (e.g. a browser extension) can manage your notes while the app is running.

## Features

- Runs an HTTP server on `127.0.0.1` only (never exposed to the LAN).
- Every request requires `Authorization: Bearer <api-key>`; the key is generated automatically and can be copied or regenerated in settings.
- Full markdown note CRUD over the Vault API:
  - `GET /api/status` — health check (vault name, plugin version)
  - `GET /api/notes?folder=&q=` — list notes (optional folder prefix / keyword filter)
  - `GET /api/notes/<path>` — read a note's content
  - `POST /api/notes` — create a note, body: `{"path": "folder/note.md", "content": "..."}` (parent folders are created automatically)
  - `PUT /api/notes/<path>` — replace a note's content, body: `{"content": "..."}`
  - `DELETE /api/notes/<path>` — move a note to the system/Obsidian trash
- CORS is open (`*`) but useless without the API key; only markdown (`.md`) files are touched, and `..`/absolute paths are rejected.
- Desktop only.

## Example

```bash
KEY="<paste from settings>"
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:27124/api/notes
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:27124/api/notes/Inbox/idea.md
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"path":"Inbox/new.md","content":"# Hello"}' http://127.0.0.1:27124/api/notes
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content":"# Updated"}' http://127.0.0.1:27124/api/notes/Inbox/new.md
curl -X DELETE -H "Authorization: Bearer $KEY" http://127.0.0.1:27124/api/notes/Inbox/new.md
```

## Settings

- **Port** — localhost port (default `27124`), apply & restart after changing.
- **API key** — required for all requests; copy/regenerate here.
- **Start on launch** — auto-start the server when the vault opens.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # strict lint + typecheck + production bundle to dist/
npm run deploy   # build + copy into local vaults
```

## License

MIT
