# Context Monitor

Read-only Antigravity 2.0 Side Panel (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) plugin that tracks conversation context tokens, cache hit ratio, `/compact` resets, and per-step growth from local `transcript.jsonl`.

## Layout

- `plugin.json` — Plugin manifest (only standard Antigravity manifest fields; no unknown top-level keys).
- `assets/logo.svg` — Square plugin icon (`128x128`) referenced by `plugin.json`.
- `sidecars/context_monitor/sidecar.json` — Sidecar config (`node main.mjs`, `restart_policy: "always"`).
- `sidecars/context_monitor/main.mjs` — `SidecarApp` server; inlines `styles.css` & `app.js` on `GET /`, hot-reloads `transcript_reader.mjs` by `mtimeMs`, serves `GET /api/context` (`Cache-Control: no-store`).
- `sidecars/context_monitor/transcript_reader.mjs` — Incremental 64KB chunked JSONL parser (`PLANNER_RESPONSE` + `CHECKPOINT`), `mtimeMs:size` ETag, bounded LRU (`MAX_CACHE_ENTRIES = 16`), symlink boundary check, opt-in fallback (`allowFallback`).
- `sidecars/context_monitor/{index.html,styles.css,app.js}` — Visibility-aware & backoff polling UI (`cache: 'no-store'`), skeleton loading, 36-bar keyboard-accessible chart (`MAX_BARS = 36`), 20-row internal scroll table (`MAX_ROWS = 20`), host theme CSS tokens.
- `tests/transcript_reader.test.mjs` — Zero-dependency `node:test` suite for parser, incremental/chunked reads, compaction, and path isolation.

## Constraints

- **Read-only & zero-token**: Only read local `transcript.jsonl` via `ANTIGRAVITY_EXECUTABLE_DATA_DIR`; never write transcripts or host `config.json`.
- **UI language**: Keep all plugin UI copy in English.
- **Asset delivery**: Keep `styles.css` and `app.js` inlined by `renderPageHtml()` in `main.mjs`; do not switch to external subresource links (blocked in host iframe).
- **Hot reload**: Frontend edits apply when reopening the panel; `transcript_reader.mjs` reloads automatically on `mtimeMs` change; `main.mjs` / `*.json` edits require toggling the plugin off and on (`~/.gemini/config/plugins/context-monitor` symlinks here).

## Verify

```sh
node --check sidecars/context_monitor/main.mjs && \
node --check sidecars/context_monitor/transcript_reader.mjs && \
node --check sidecars/context_monitor/app.js && \
node --test tests/*.test.mjs
```
