# Context Monitor

Read-only Antigravity 2.0 Side Panel (`Auxiliary Pane`) plugin for monitoring conversation context window usage, cache hit ratio, `/compact` resets, and per-step token growth (`v1.1.0`).

## Features

- **Zero token overhead & strictly read-only**: Reads only local `transcript.jsonl` logs; never calls an LLM or modifies transcripts or host configuration
- **Current-turn telemetry**: Tracks `input_tokens + cache_read_tokens`, cache hit rate, output tokens, and cumulative session totals
- **Live compaction tracking**: Shows `Compacting…` when `/compact` starts, renders estimated post-compaction usage immediately on `CHECKPOINT`, marks compaction events in the chart and table, and reconciles with exact counts on the next turn
- **Visual breakdown**: Displays a 36-step stacked bar chart and a 20-row internally scrollable recent steps table styled with host theme CSS variables
- **Lightweight incremental parser**: Uses 64KB chunked byte-offset reads, `mtimeMs:size` ETag caching, a bounded 16-session LRU cache, and strict per-session isolation (`?fallback=1` opt-in for standalone browser debugging)
- **Display budget selector**: Switch UI warning thresholds (`75%` / `90%`) between `200K`, `256K`, `512K`, `1M`, and `2M` in `localStorage` without affecting the underlying model window

## Prerequisites

- **Antigravity 2.0** (provides `sidecar_sdk` at runtime)
- Zero external npm dependencies (optional **Node.js 18+** if running the local unit tests)

## Installation

### Option 1: Global install (recommended)

Clone directly into your global Antigravity plugins directory so it is available across all workspaces:

```sh
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/Cheerwhy/context-monitor.git ~/.gemini/config/plugins/context-monitor
```

If you prefer keeping the repository in your own projects folder, clone it there and symlink it:

```sh
git clone https://github.com/Cheerwhy/context-monitor.git ~/projects/context-monitor
ln -s ~/projects/context-monitor ~/.gemini/config/plugins/context-monitor
```

### Option 2: Workspace-scoped install

Clone into a single project's `.agents/plugins/` directory:

```sh
mkdir -p .agents/plugins
git clone https://github.com/Cheerwhy/context-monitor.git .agents/plugins/context-monitor
```

After installing, open **Customizations → Plugins** in Antigravity and make sure **Context Monitor** is enabled.

## Usage

- Open the side panel from the `+` menu in the Antigravity conversation header by selecting **Context Monitor** (or via `[Context Monitor](sidecar://context-monitor/context_monitor/)`).
- Click the **Live** status pill in the panel header at any time to trigger an immediate refresh (auto-polling runs every `1.5s` while visible and pauses when hidden).
- **Tip on `Limit`**: Antigravity doubled its automatic context checkpoint threshold from `256K` to **`~512K` tokens** on newer deep-context models (e.g., Gemini 4 Argon / Neon). Keeping the top-right **Limit** picker at `512K` aligns the `75%` / `90%` warning colors with the auto-compaction threshold; use `1M` / `2M` to compare against raw window capacity (a `~512K` reference tick is shown on the bar), or `256K` / `200K` for smaller limits.

## Development & Testing

```sh
# Syntax checks and zero-dependency unit tests
node --check sidecars/context_monitor/main.mjs && \
node --check sidecars/context_monitor/transcript_reader.mjs && \
node --check sidecars/context_monitor/app.js && \
node --test tests/*.test.mjs

# Standalone sidecar debugging in a browser (http://127.0.0.1:43123/?fallback=1)
ANTIGRAVITY_LS_ADDRESS=127.0.0.1:5387 \
ANTIGRAVITY_CSRF_TOKEN=dev \
ANTIGRAVITY_SIDECAR_WEB_PORT=43123 \
node --import ~/.gemini/config/node_modules/sidecar_sdk/register_loader.js sidecars/context_monitor/main.mjs
```
