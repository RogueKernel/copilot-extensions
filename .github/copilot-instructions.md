# Copilot instructions

This repository is a Copilot CLI plugin marketplace. The active plugin is `copilot-cost`; it bundles an undocumented/native Copilot CLI extension at `plugins/copilot-cost/extensions/copilot-cost/extension.mjs`.

## Build, test, and lint commands

- Syntax-check the extension: `cd plugins/copilot-cost/extensions/copilot-cost && npm run check`
- Run the full test suite: `cd plugins/copilot-cost/extensions/copilot-cost && npm test`
- Run one test file: `cd plugins/copilot-cost/extensions/copilot-cost && node --test test/unit/cost.test.mjs`
- Smoke-test the statusline runtime with isolated settings: `cd plugins/copilot-cost/extensions/copilot-cost && npm run smoke:statusline`
- Run all validation checks: `cd plugins/copilot-cost/extensions/copilot-cost && npm run validate`
- There is no lint script or build script.

## Architecture pointers

- Marketplace manifest: `.github/plugin/marketplace.json`; plugin root: `plugins/copilot-cost`; bundled extension: `plugins/copilot-cost/extensions/copilot-cost`.
- Copilot CLI 1.0.62 and newer loads plugin-shipped native extensions from installed plugin `extensions/<name>/extension.mjs` directories. `copilot-cost` no longer uses a setup skill or managed user-extension shim.
- `extension.mjs` stays thin: normal sessions use `src/runtime/extension.mjs`; statusline invocations run `node extension.mjs --statusline` and use `src/runtime/statusline.mjs`.
- Copilot-owned configuration remains in `~/.copilot/settings.json`. Product-owned runtime data lives under `${COPILOT_PLUGIN_DATA}` or `~/.copilot/plugin-data/copilot-extensions/copilot-cost`.
- Native extension behavior is underdocumented. Use `docs/references/github-copilot-extensions/` for verified local behavior; keep plugin behavior aligned with docs.github.com.
- Full install/update/uninstall docs: `docs/copilot-cost/usage.md`; runtime architecture: `docs/copilot-cost/architecture.md`; contributor workflow: `docs/copilot-cost/development.md`.

## Key conventions

- Keep `extension.mjs` thin. It is launched both by SDK bootstrap and directly by Node for statusline rendering, so it should stay easy to audit.
- The extension version lives in `plugins/copilot-cost/extensions/copilot-cost/package.json`; bump it whenever changing extension or plugin files, and keep package, lockfile, plugin, and marketplace metadata versions aligned.
- This repository intentionally packages `copilot-cost` as a plugin marketplace item that bundles a native Copilot CLI extension. Keep plugin metadata aligned with the native extension, but do not change runtime code just for packaging.
- Do not add `@github/copilot-sdk` to dependencies. The CLI provides it to extension child processes; keep SDK imports inside the extension runtime function so statusline mode works without SDK resolution.
- Keep module exports sparse. Helpers used by only one module should remain private.
- Prefer simple names and small files over broad utility modules.
- Use small pure helpers for parsing, formatting, accounting, and estimates. Event handlers should collect data and delegate calculations rather than embedding business logic inline.
- Preserve the official-vs-pending accounting model. `Total` combines locally observed assistant/compaction usage while the official counter lags, then the native extension uses `session.rpc.usage.getMetrics().totalNanoAiu` when available to reconcile the durable total and subtract caught-up pending cost. `Sess` displays that same official session counter. The standalone statusline command is read-only: it renders summary state and cached windows but must not persist usage, context, or ledger updates.
- 24h/7d/30d windows are derived from the versioned session ledger and cached in `summary-state.v<plugin-version>.json`. Full sync may fold current summary runtime totals for still-open sessions into the ledger because active JSONL logs can lack live cost until shutdown. Startup and `/cost` force full sync. Completed turns and successful compactions may trigger full sync only after claiming a stale summary `windows.updatedAt` timestamp, currently five minutes old. Do not replace this with local-only `assistant.usage` totals, live per-turn rolling-window deltas, `history.json`, or another rolling-history store.
- Session ledger sync is metadata-gated. Stable finalized rows and stale open rows with unchanged event-file size/mtime should be skipped before tail-reading or parsing; changed metadata should still reparse so late shutdown/model data can correct the ledger. Stale open sessions older than 7 days become `auto_closed`, except the current session.
- Usage-based billing started on 2026-06-01, so pre-cutover pay-per-message totals must not be treated as usage-based cost; use retained token telemetry to estimate historical equivalent cost under the current usage-based model only when a trustworthy model/token-rate profile exists. Keep the `officialStartedUsd` turn-start guard to avoid double-counting. If using account/quota APIs, avoid flows that unexpectedly trigger OS keychain prompts; prefer already-authenticated extension surfaces or explicit opt-in.
- Treat missing files as expected only in `readJson` for `ENOENT`; other JSON or filesystem errors should propagate.
- When writing JSON state/settings, use `writeJson` so parent directories are created and files are formatted with a trailing newline.
- Use `num()` for finite-number-or-zero semantics and `optNum()` when absence must be preserved. Use `dropUndefined()` on state patches so missing live data does not erase previously known values.
- Add new user-visible format placeholders in `DISPLAY.formatTokens` and the token map in `render/summary.mjs`; do not add alternate aliases unless explicitly requested.
- `/cost` direct arguments should parse through canonical `parseMode`, `parseUnit`, or related parsers. Interactive UI paths must still provide a non-elicitation fallback via `session.log`.
- After editing extension files, reload Copilot CLI extensions with `/clear` in the CLI or the extension reload command available in the current session.
