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

There is no separate lint or build script. `npm run check` syntax-checks the extension entrypoint and plugin setup scripts, and `npm run validate` runs tests, syntax check, and the statusline smoke test.

## Dependencies

The extension uses Node's built-in test runner and no third-party test dependencies.

Do not install or list `@github/copilot-sdk` as a dependency. Copilot CLI provides it to extension child processes through its own runtime resolver. Keep the SDK import inside the extension runtime function so `node extension.mjs --statusline` can run without `SESSION_ID` or SDK resolution.

## Tests

Tests are split by scope:

| Path | Scope |
| --- | --- |
| `test/unit/` | Small pure behavior such as accounting, estimates, rendering, settings parsers, state paths, and runtime seams. |
| `test/e2e/` | Process behavior such as statusline stdin-to-stdout rendering and state persistence. |

After editing extension or setup-script code, run `npm run validate` from `plugins/copilot-cost/extensions/copilot-cost`.

## Contributor conventions

- Keep `extension.mjs` thin so host discovery and direct statusline execution stay obvious.
- Keep runtime modules orchestration-only. Event handlers should collect host data, filter out sub-agent lifecycle events where needed, and delegate calculations.
- Keep module exports sparse. If a helper is only used inside one file, leave it private.
- Prefer simple verbs and domain nouns: `collect`, `estimate`, `render`, `configure`, `turn`, `state`, `snapshot`, `rate`.
- Preserve persistence semantics: missing JSON files are expected only in `readJson()` for `ENOENT`; malformed JSON and other filesystem errors should surface.
- Write JSON state and settings with `writeJson()` so parent directories are created and files are formatted with a trailing newline.
- Use `updateSessionLedger()` for ledger read-modify-write paths so concurrent statusline/extension processes serialize updates and persist with atomic rename.
- Keep `session-ledger.json` lean and content-free. The JSONL parser may retain only cost/token metadata, timestamps, session ids, and file metadata; runtime state may retain only values needed for reconciliation, context/rate display, estimates, and last-message formatting. It must not persist prompts, responses, transcript text, paths, tool arguments, or source code.
- Rolling 24h/7d/30d totals must come from the session ledger. Do not reintroduce a `history.json` fallback.
- Use `num()` for finite-number-or-zero semantics and `optNum()` when absence must be preserved.
- Use `dropUndefined()` on state patches so missing live data does not erase previously known values.
- Add new user-visible format placeholders to `DISPLAY.formatTokens` and the token map in `render/summary.mjs`; do not add alternate aliases unless explicitly requested.
- Parse `/cost` direct arguments through canonical parsers such as `parseMode()` and `parseUnit()`. Interactive UI paths must still provide a non-elicitation fallback via `session.log`.
- Bump the extension version whenever changing extension or plugin files, and keep package, lockfile, plugin, and marketplace metadata versions aligned.

After editing extension files, reload Copilot CLI extensions with `/clear` or start a new Copilot CLI session. In current Copilot CLI, `/extensions` opens a menu with **manage** and **mode** options; use **manage** to enable or disable discovered extensions.
