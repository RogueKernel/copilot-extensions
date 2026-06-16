---
applyTo: "plugins/copilot-cost/extensions/copilot-cost/src/domain/session-*.mjs,plugins/copilot-cost/extensions/copilot-cost/src/domain/vscode-session.mjs,plugins/copilot-cost/extensions/copilot-cost/src/domain/windows.mjs,plugins/copilot-cost/extensions/copilot-cost/test/unit/session-*.test.mjs,plugins/copilot-cost/extensions/copilot-cost/test/unit/vscode-session.test.mjs"
---

# copilot-cost session ledger and sync rules

- For ledger costing changes, consult `docs/copilot-cost/algorithms/historical-cost.md` before editing source precedence, token estimates, stale auto-close, or rolling-window behavior.
- The session ledger stores one compact, content-free record per retained local Copilot session. Records have `state`, `surface`, cost `source`, timestamps, optional event-file metadata, optional model metrics, and optional token totals.
- Preserve ledger states: `open`, `closed`, and `auto_closed`. Recent no-shutdown sessions stay `open`; open sessions whose `lastSeenAt` is at least seven days old become `auto_closed`, except the current session.
- Preserve surfaces: `cli` for Copilot CLI session-state telemetry and `vscode` for supported VS Code-family Copilot telemetry. Legacy records without `surface` must normalize deterministically from their ids.
- Keep `syncSessionLedger()` metadata-gated. Stable finalized rows and stale open rows with matching `eventFileSize` and `eventFileMtimeMs` should be skipped before tail-reading or streaming JSONL files. Changed metadata must trigger a reparse so late shutdown/model data can correct the ledger.
- Do not reparse or retain sessions outside the configured retention horizon except when the current active session requires it. Full sync should prune ledger records outside retention.
- Shutdown `totalNanoAiu` is authoritative and can replace higher live/usage observations. Summed shutdown `modelMetrics.*.totalNanoAiu` is a fallback when `totalNanoAiu` is absent.
- During full sync, fold current summary runtime totals for still-open sessions into the ledger with the `runtime` source. This lets rolling windows include active concurrent sessions even when their JSONL event files contain only message/token metadata until shutdown.
- Rolling 24h/7d/30d windows come from `sessionLedgerWindows()` over ledger usage events, then are cached in summary state by `syncSessionLedgerCacheAndSummary()`.
- Parser and export code may retain cost/token metadata, timestamps, session ids, session surface, parse counts, and normalized event-file labels only. Never persist prompts, responses, transcript text, tool arguments, source code, or absolute local paths.
- Keep VS Code telemetry as local retained history for reporting, not as account-wide Copilot billing. Overview and Analysis should label source/surface distinctions clearly.
- Sync tests should cover new sessions, recent open sessions, stale auto-close, metadata-gated skips, changed-file reparses, retention pruning, VS Code groups, concurrent open sessions, and window recomputation.
