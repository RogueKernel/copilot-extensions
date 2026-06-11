---
applyTo: "plugins/copilot-cost/**,docs/copilot-cost/**,README.md,LEARNINGS_TO_INVESTIGATE.md"
---

# copilot-cost accounting guardrails

- Preserve the official-vs-pending model in `plugins/copilot-cost/extensions/copilot-cost/src/domain/cost.mjs`.
- `assistant.usage` and compaction events create local pending cost while Copilot's official counter lags; they are not enough for final `Total` because they can miss tool calls and sub-agent work.
- Statusline `ai_used.total_nano_aiu` is the official active-session counter. It must reconcile `Total`, clear caught-up `pendingUsd`, update `Sess`, and update the current `session-ledger.json` record when `session_id` is present.
- Rolling 24h/7d/30d windows are ledger-derived. Do not reintroduce `history.json` or any other legacy rolling-history fallback.
- Usage-based billing started on 2026-06-01. Pre-cutover pay-per-message totals must not be treated as usage-based cost; use retained JSONL token telemetry to estimate historical equivalent cost under the current usage-based model when a post-cutover token-rate profile exists.
- Do not change statusline handling to "Sess-only" or make rolling windows local-only. The e2e tests named `statusline reconciles official session usage into Total and ledger windows`, `statusline official catch-up replaces lower locally observed total`, and `statusline scopes totals to each session under a shared session-state root` protect this behavior.
- Keep `session-ledger.json` content-free. JSONL historical sync may retain cost/token metadata, timestamps, session ids, and file metadata only; runtime state may retain only reconciliation, context/rate, estimate, and last-message display values. Never persist prompts, responses, transcript text, paths, tool arguments, or source code.
- Keep runtime state in the ledger's top-level `runtime` map; do not recreate `sessions/*.json`. Use `updateSessionLedger()` for ledger read-modify-write paths so concurrent statusline/extension processes serialize updates and write atomically.
- Preserve ledger states: `open`, `closed`, and `auto_closed`. Do not re-aggregate known `open`/`closed`/`auto_closed` sessions from JSONL during startup; live statusline updates maintain open sessions, and stale open sessions older than 7 days become `auto_closed`.
- Keep the `officialStartedUsd` turn-start guard in `src/runtime/extension.mjs`; it prevents double-counting when official usage catches up while a turn is in flight.
- If account/quota APIs are investigated, avoid implementation paths that trigger unexpected OS keychain prompts. Use already-authenticated extension/statusline surfaces or require explicit user opt-in.
