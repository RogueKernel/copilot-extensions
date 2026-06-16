---
applyTo: "plugins/copilot-cost/extensions/copilot-cost/src/domain/**,plugins/copilot-cost/extensions/copilot-cost/src/runtime/**,plugins/copilot-cost/extensions/copilot-cost/src/render/**,plugins/copilot-cost/extensions/copilot-cost/test/unit/**"
---

# copilot-cost accounting guardrails

- For estimate or accounting changes, consult `docs/copilot-cost/algorithms/next-message-cost-estimate.md` and `docs/copilot-cost/algorithms/historical-cost.md` before editing code.
- Preserve the official-vs-pending model in `src/domain/cost.mjs`. `assistant.usage` and successful compactions create local pending cost while Copilot's official counter lags; they are not sufficient as final `Total` because they can miss tool-side and sub-agent work.
- The native extension may call `session.rpc.usage.getMetrics().totalNanoAiu` to reconcile current-session display state. That official counter updates `Total`, clears caught-up `pendingUsd`, and updates the displayed `Sess` value in summary runtime state.
- The standalone statusline command is read-only. It must not reconcile official usage, write context, or update the ledger from stdin `ai_used.total_nano_aiu`.
- Keep `officialStartedUsd` in `src/runtime/extension.mjs`. It prevents double-counting when official usage catches up while a turn is in flight.
- Rolling 24h/7d/30d values are not live per-turn accounting. They are recomputed from the session ledger during full sync and cached in summary state. Full sync may fold current summary runtime totals for still-open sessions into the ledger because active JSONL logs can lack live cost until shutdown. Do not reintroduce live per-turn rolling-window deltas, `history.json`, or another parallel rolling-history store.
- Usage-based billing started on 2026-06-01. Pre-cutover pay-per-message totals must not be treated as usage-based cost. Retained pre-cutover token telemetry may be shown only as a historical equivalent under the current usage-based model when a trustworthy model/token rate is available.
- Token pricing must remain per model and per token class. Do not use a blended global rate when the model or token class is unknown.
- Keep retained accounting data content-free: no prompts, responses, transcript text, tool arguments, source code, or absolute local paths.
- If account/quota APIs are investigated, avoid paths that unexpectedly trigger OS keychain prompts. Prefer already-authenticated extension surfaces or explicit opt-in.
