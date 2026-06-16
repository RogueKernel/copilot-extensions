# copilot-cost development

## Commands

Run extension commands from `plugins/copilot-cost/extensions/copilot-cost`:

```sh
npm test
npm run check
npm run smoke:statusline
npm run validate
```

Run one test file:

```sh
node --test test/unit/cost.test.mjs
```

There is no separate lint or build script. `npm run check` syntax-checks the extension entrypoint and source modules, and `npm run validate` runs tests, syntax check, and the statusline smoke test.

## Install from a local checkout

These commands are for maintainers testing local, unpushed changes. End users should use the marketplace install and update commands in [`usage.md`](usage.md).

From any terminal, register this local checkout as a marketplace and install from it:

```sh
REPO="/path/to/copilot-extensions"
copilot plugin marketplace remove copilot-extensions 2>/dev/null || true
copilot plugin marketplace add "$REPO"
copilot plugin install copilot-cost@copilot-extensions
copilot --experimental
```

Inside Copilot CLI, run `/clear` or start a new session, then use `/cost`.

To keep the test isolated from your real Copilot config, set isolated homes before the marketplace commands:

```sh
export COPILOT_HOME="$(mktemp -d)"
export COPILOT_CACHE_HOME="$COPILOT_HOME/cache"
```

## Dependencies

The extension uses Node's built-in test runner and no third-party test dependencies.

Do not install or list `@github/copilot-sdk` as a dependency. Copilot CLI provides it to extension child processes through its own runtime resolver. Keep the SDK import inside the extension runtime function so `node extension.mjs --statusline` can run without `SESSION_ID` or SDK resolution.

## Tests

Tests are split by scope:

| Path | Scope |
| --- | --- |
| `test/unit/` | Small pure behavior such as accounting, estimates, rendering, settings parsers, state paths, and runtime seams. |
| `test/e2e/` | Process behavior such as statusline stdin-to-stdout rendering and read-only summary-state behavior. |

After editing extension code, run `npm run validate` from `plugins/copilot-cost/extensions/copilot-cost`.

## Contributor conventions

- Keep `extension.mjs` thin so host discovery and direct statusline execution stay obvious.
- Keep runtime modules orchestration-only. Event handlers should collect host data, filter out sub-agent lifecycle events where needed, and delegate calculations.
- Keep module exports sparse. If a helper is only used inside one file, leave it private.
- Prefer simple verbs and domain nouns: `collect`, `estimate`, `render`, `configure`, `turn`, `state`, `snapshot`, `rate`.
- Preserve persistence semantics: missing JSON files are expected only in `readJson()` for `ENOENT`; malformed JSON and other filesystem errors should surface.
- Write JSON state and settings with `writeJson()` so parent directories are created and files are minified with a trailing newline.
- Use `syncSessionLedgerCacheAndSummary()` only from full ledger sync paths that rebuild the derived ledger cache from Copilot/VS Code telemetry, and refresh cached summary windows immediately after that cache write. Runtime events must not mutate the ledger; use summary-state helpers for hot-path display state, so concurrent footer/extension processes serialize updates and persist with atomic rename.
- Keep `syncSessionLedger()` metadata-gated. Normal startup and `/cost` should parse only new sessions, current/recent open sessions, or known rows whose stored event-file size/mtime changed. Stable finalized rows (`closed`, `auto_closed`, and stale `open`) must be skipped before tail-reading or streaming the JSONL file; changed metadata should still trigger a reparse so late shutdown/model data can correct the ledger.
- Keep the versioned `session-ledger.v<plugin-version>.json` file lean and content-free. The JSONL parser may retain only cost/token metadata, timestamps, session ids, session surface, and file metadata. Runtime display/reconciliation state belongs in the versioned `summary-state.v<plugin-version>.json` file, not the ledger. Neither file may persist prompts, responses, transcript text, paths, tool arguments, or source code.
- Keep `COPILOT_COST_DEBUG.jsonl` and `debug-events.jsonl` out of commits. Both diagnostics should stay redacted: event metadata, cost/token/model summaries, ledger rows, normalized session-state path labels, and sanitized event/RPC shapes only.
- Rolling 24h/7d/30d totals must be recomputed from the session ledger during full sync and cached in the current version's summary-state file for hot-path rendering. Full sync may fold current summary runtime totals for still-open sessions into the ledger because active JSONL logs can lack live cost until shutdown. Completed turns and successful compactions may trigger a full sync only after claiming a stale `summary-state` window timestamp, currently five minutes old. Do not reintroduce live per-turn rolling-window deltas or a `history.json` fallback.
- Use `num()` for finite-number-or-zero semantics and `optNum()` when absence must be preserved.
- Use `dropUndefined()` on state patches so missing live data does not erase previously known values.
- Add new user-visible format placeholders to `DISPLAY.formatTokens` and the token map in `render/summary.mjs`; do not add alternate aliases unless explicitly requested.
- Parse `/cost` direct arguments through canonical parsers such as `parseMode()` and `parseUnit()`. Interactive UI paths must still provide a non-elicitation fallback via `session.log`.
- Bump the extension version whenever changing extension or plugin files, and keep package, lockfile, plugin, and marketplace metadata versions aligned.

## Performance Notes

Benchmarks on a local dataset with 662 CLI session folders and 38 VS Code telemetry groups put normal startup or `/cost` sync in the low hundreds of milliseconds after metadata gating. The same full sync is acceptable as a throttled post-turn refresh, but only after the shared five-minute summary timestamp says it is due. The statusline command must stay read-only because process startup dominates its cost. **Export Session Data** is the known expensive path because it intentionally streams every discovered CLI JSONL file to produce event/type counts and redacted diagnostics; keep that action manual and avoid moving export-style full scans into startup, statusline, or ordinary `/cost` rendering.

After editing extension files, reload Copilot CLI extensions with `/clear` or start a new Copilot CLI session. In current Copilot CLI, `/extensions` opens a menu with **manage** and **mode** options; use **manage** to enable or disable discovered extensions.
