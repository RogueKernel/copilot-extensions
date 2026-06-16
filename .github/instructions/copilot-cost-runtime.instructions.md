---
applyTo: "plugins/copilot-cost/extensions/copilot-cost/extension.mjs,plugins/copilot-cost/extensions/copilot-cost/src/runtime/**,plugins/copilot-cost/extensions/copilot-cost/src/*state.mjs,plugins/copilot-cost/extensions/copilot-cost/src/storage.mjs,plugins/copilot-cost/extensions/copilot-cost/src/io.mjs,plugins/copilot-cost/extensions/copilot-cost/test/e2e/**,plugins/copilot-cost/extensions/copilot-cost/test/unit/runtime.test.mjs,plugins/copilot-cost/extensions/copilot-cost/test/unit/*state.test.mjs"
---

# copilot-cost runtime and persistence rules

- Keep `extension.mjs` thin. Normal sessions route to `src/runtime/extension.mjs`; `node extension.mjs --statusline` routes to `src/runtime/statusline.mjs`.
- Do not add `@github/copilot-sdk` as a package dependency. Copilot CLI provides it to native extension processes; keep SDK imports inside `runExtension()` so statusline mode works without SDK resolution.
- The statusline process is a read-only renderer. It reads one stdin payload to identify the session workspace, loads summary state, renders, and exits. It must not persist usage, context, or ledger updates.
- Runtime display state belongs in `summary-state.v<plugin-version>.json` under the top-level `runtime` map. Do not recreate `sessions/*.json`, and do not put runtime reconciliation data in the session ledger.
- Use `mergeRuntimeState()`, `saveUsageWindows()`, and `claimUsageWindowSync()` for summary-state writes. These use the shared JSON update path so concurrent extension/statusline processes serialize writes and use atomic rename.
- Missing JSON files are expected only through `readJson()` returning `undefined` for `ENOENT`. Malformed JSON and other filesystem errors should surface unless the caller is intentionally best-effort.
- Detached startup and post-turn sync work must be best-effort and must not break after-message rendering or statusline output if telemetry sync fails.
- Completed turns and successful compactions may trigger a full ledger sync only after claiming a stale summary `windows.updatedAt` timestamp, currently five minutes old. Claim first, then sync, so concurrent sessions do not all perform the same expensive work.
- Keep context handling scoped to the native extension. `session.usage_info` updates summary runtime state after startup is ready; statusline stdin context values are not persisted.
- Tests for runtime changes should cover normal success, skipped/fresh sync, failed best-effort sync, and concurrent summary-state behavior where relevant.
