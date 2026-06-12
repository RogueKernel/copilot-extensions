# copilot-cost architecture

`copilot-cost` is a Copilot CLI extension that shows message cost, context usage, cache health, a cumulative Copilot CLI session total, and rolling cost windows after assistant messages and in the statusline footer.

## Source layout

The bundled native extension entrypoint is `plugins/copilot-cost/extensions/copilot-cost/extension.mjs`. Installed users run it through a managed shim at `~/.copilot/extensions/copilot-cost/extension.mjs`. The entrypoint only chooses the runtime:

| Runtime | Launch path | Responsibility |
| --- | --- | --- |
| Extension runtime | Imported by the Copilot extension bootstrap | Listens to usage events and persists conversation/runtime state. |
| Statusline runtime | `<setup-node> extension.mjs --statusline` | Reads one JSON status payload from stdin, refreshes stored display state, and prints footer text. |

Copilot CLI discovers project extensions from immediate subdirectories under `.github/extensions/`; each extension must keep a file named exactly `extension.mjs`. User-scoped extensions can also live under `~/.copilot/extensions/`. The marketplace plugin does not make native extensions first-class install artifacts yet, so the setup script writes the user-scoped shim explicitly.

Implementation lives under `plugins/copilot-cost/extensions/copilot-cost/src/`:

| Path | Role |
| --- | --- |
| `runtime/` | Host event wiring and process entrypoints. |
| `domain/` | Accounting, session-ledger sync, JSONL metadata parsing, redacted session export, estimates, rate extraction, rolling windows, snapshots, context readers, and turn accumulation. |
| `render/` | Terminal output formatting. |
| `settings.mjs` | Global display settings, parsers, and the `/cost` command flow. |
| `state.mjs` | Persisted runtime state and statusline workspace discovery. |
| `io.mjs`, `math.mjs`, `config.mjs` | Shared foundations for persistence, numeric coercion, constants, and display tokens. |

## Runtime flow

1. `extension.mjs` checks for `--statusline`.
2. Normal extension sessions call `runExtension()`, import `@github/copilot-sdk/extension` inside that function, join the session, register `/cost`, and attach event handlers.
3. On attach, the runtime starts a best-effort session-ledger sync for the current Copilot CLI session id. It discovers recent `~/.copilot/session-state/*/events.jsonl` files, parses only whitelisted cost/token metadata for new or changed session files, and auto-closes stale open sessions.
4. Assistant usage events accumulate into the current turn. On `session.idle`, the runtime snapshots the turn, merges it into plugin-data runtime state, and logs the after-message summary when enabled.
5. Successful `session.compaction_complete` events add compaction usage because they arrive outside the normal turn lifecycle.
6. Best-effort `session.shutdown` events close the current ledger record when Copilot gives the extension time to persist the final shutdown total.
7. Statusline invocations call `printStatusline()`, read stdin, find the session workspace, reconcile Copilot's official usage counter into `Total`, update the current session-ledger record from `session_id` plus `ai_used.total_nano_aiu`, refresh the cumulative totals group (`Sess`, `24h`, `7d`, `30d`), update context, and print the footer when enabled.

The `/cost` Settings flow can also run a diagnostic export. **Export Session Data** discovers the same local `~/.copilot/session-state/*/events.jsonl` files, reads the current `session-ledger.json`, and writes `COPILOT_COST_DEBUG.jsonl` in the current working directory. Each JSONL row represents one discovered session and keeps event-file metadata, event/type counts, extracted token/cost/model summaries, and the matching ledger row when present. It does not export prompts, assistant responses, transcript text, tool arguments, source code, or absolute local paths; event-file paths are normalized to session-state labels.

Sub-agent lifecycle events carry an `agentId`; the runtime ignores those for main-session turn timing and context updates so sub-agent work does not distort the active user's turn.

Footer output uses Copilot CLI's built-in Custom Footer. The setup script configures `statusLine.command`, enables `footer.showCustom`, and points the command at the plugin-bundled extension directly with `node`. The command is run by Copilot as a normal configured executable, not as a native extension subprocess, so Node.js 18+ must be installed and available as `node`. If another statusline command already exists, setup replaces it with the `copilot-cost` command; the previous value is saved for managed uninstall restoration. `Total` is the reconciled best-known conversation total. The cumulative totals group shows `Sess`, Copilot's raw official CLI session aggregate, alongside ledger-derived rolling 24h/7d/30d totals.

## Accounting boundaries

In Copilot CLI extension internals, a host `session` is the running Copilot instance in one terminal. It starts when `copilot` is opened and ends when that terminal instance exits. `copilot-cost` scopes persisted runtime state by the active workspace/session path, but it does not treat that Copilot CLI session as a conversation or account accounting boundary.

`session.rpc.usage.getMetrics()`, `session.shutdown` usage metrics, and the statusline `ai_used.total_nano_aiu` value are Copilot CLI session aggregates. These sessions are terminal instances, not durable conversations or account boundaries. `copilot-cost` still uses the statusline value as the active official counter for reconciliation: local assistant/compaction costs remain pending while the counter lags, then positive official catch-up updates `Total`, clears caught-up pending cost, updates the cumulative `Sess` total, and updates the current session-ledger record used by rolling 24h/7d/30d windows.

Copilot CLI's built-in `/usage` command displays broader account/activity information, including last-180-days activity, total messages, changes, AI Credits, and token totals with cached and reasoning-token breakdowns. That is the desired class of source for account-level cumulative metrics, but no native-extension RPC/API for reading `/usage` output has been verified yet. The `account.getQuota` RPC and the underlying internal account endpoint can return billing-period quota snapshots, but not 24h/7d/30d historical spend, and direct external probes may trigger OS keychain prompts.

## Cost model

Current-turn and next-response estimates are derived from live `copilotUsage.tokenDetails` rates whenever Copilot provides them. Token-detail names vary by provider, so `domain/rates.mjs` classifies input, output, cache-read, and priced cache-write rows behind small predicates.

Conversation totals use an official-vs-pending model. Observed assistant-message usage and successful compactions are recorded as pending local cost because those events can miss tool and sub-agent work. Statusline `ai_used.total_nano_aiu` is the official active-session counter that reconciles that pending cost into `Total` and updates the current session-ledger record. The `officialStartedUsd` turn-start guard prevents usage that becomes official mid-turn from being counted twice.

Next-response estimates use the current context size and live rates. The lower bound assumes warm-cache input blended by the expected cache-hit ratio; the upper bound uses cold-cache/cache-write pricing when available. Recent uncached input/output work samples are included so the estimate is not only the existing context cost.

GitHub Copilot usage-based billing converts model-specific token prices into AI credits, with 1 AI credit equal to $0.01 USD. Copilot's telemetry still uses `aiu` / AIU naming in places; in this domain model AIU is treated as the legacy/internal name for the same unit as AI Credits, not a separate currency. The built-in historical fallback rates in `domain/model-pricing.mjs` mirror GitHub's published model pricing table at <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing>. They are used only for token-only history when no authoritative AIU total or local observed rate can price that model/token class.

Historical token-only conversion is per model and per token class. GitHub's published prices are USD per 1 million tokens, so the equivalent formula is `usd = sum(tokenCountForClass * usdPerMillionForModelAndClass / 1_000_000)`. Internally the plugin converts the same rate through AI Credits/AIU precision as `nanoAiuPerToken = usdPerMillion / 0.01 * 1_000_000_000 / 1_000_000`, then converts back to USD for display with `usd = nanoAiu / 1_000_000_000 * 0.01`.

For token-only fallback estimates, retained `inputTokens` are treated as total input tokens, not uncached input. The billable input class is therefore `max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`, and cached/cache-write tokens are priced only by their own rates. This avoids double-counting cached input. When retained data is only an aggregate session total, tiered model pricing uses the default tier because the long-context threshold is request-scoped and cannot be inferred safely from a multi-request session aggregate.

## Session ledger domain model

The session ledger stores one compact record per local Copilot CLI session. A record has a `state`, a cost `source`, timestamps, optional event-file metadata, optional model metrics, and optional token totals.

States:

| State | Meaning |
| --- | --- |
| `open` | The session has no authoritative shutdown total yet. It may still be active, recently crashed, or inactive because the extension was not running. |
| `closed` | A shutdown or modelMetrics closure was captured. A later full shutdown can still replace a modelMetrics fallback. |
| `auto_closed` | The session was still open after the stale threshold and was closed locally for reporting. |

Cost sources, from weakest to strongest:

| Source | Meaning |
| --- | --- |
| `none` | The ledger knows the session exists but has no priced cost yet. Token/model detail may still be retained. |
| `estimated_tokens` | A low-confidence estimate from retained token totals and model rates. |
| `usage_events` / `compaction` | AIU captured from replayed or live usage events without a shutdown total. |
| `statusline` | The official live Copilot CLI session aggregate from `ai_used.total_nano_aiu`. |
| `modelMetrics` | A shutdown fallback from summed `modelMetrics.*.totalNanoAiu` when `totalNanoAiu` is absent. |
| `shutdown` | Authoritative `session.shutdown.data.totalNanoAiu`; this always wins, even if lower than prior live observations. |

Sync flow:

1. On extension attach and first-run tasks, `syncSessionLedger()` discovers `~/.copilot/session-state/*/events.jsonl` files.
2. Unknown files are parsed if they are inside the 180-day retention horizon, or if they belong to the current session.
3. Known files are re-parsed when stored `eventFileSize` or `eventFileMtimeMs` is missing or differs from the file. This lets old `source: none` rows, open usage-event rows, auto-closed estimates, and shutdown rows missing model detail be corrected when fuller event data is available.
4. The parser keeps only whitelisted timestamps, AIU totals, model metrics, token/request totals, parse-error counts, and file metadata.
5. Parsed shutdown totals close sessions authoritatively. Parsed usage/compaction AIU keeps sessions open unless a shutdown total exists.
6. After parsing, open sessions whose `lastSeenAt` is at least 7 days old become `auto_closed`, except the current session, whose `lastSeenAt` is refreshed during sync.

Open and crashed sessions are intentionally treated conservatively. A recent session without shutdown can be a real live session, a crashed session, or a session where the extension was inactive; those cases are indistinguishable from local telemetry alone. Therefore recent no-shutdown sessions stay `open`. They contribute cost only if they already have AIU from statusline, usage events, or compaction. Token-only recent sessions retain model/token detail for later estimation but do not add spend yet.

Token-only stale sessions are estimated only when a model/token-class rate is available. Local post-pricing observed rates are preferred, but only when an authoritative or usage-event profile isolates one token class. Shutdown and modelMetrics profiles take precedence over usage-event profiles for the same model/token class. If no local rate exists, the built-in GitHub pricing fallback prices known models per token class: uncached input, cached input, Anthropic cache write, and output. Unknown models or token classes without a trustworthy rate remain unpriced rather than using a blended global rate.

## Runtime state

| File | Scope | Purpose |
| --- | --- | --- |
| `~/.copilot/plugin-data/copilot-extensions/copilot-cost/settings.json` | Global user | Display mode, unit, and custom formats. |
| `~/.copilot/plugin-data/copilot-extensions/copilot-cost/session-ledger.json` | Global user | Single cost/state file. Stores compact per-Copilot-session cost records plus lean runtime display/reconciliation state. |
| `~/.copilot/plugin-data/copilot-extensions/copilot-cost/install-state.json` | Plugin installer | Previous statusline/footer settings used by managed uninstall. |
| `./COPILOT_COST_DEBUG.jsonl` | Current working directory, on demand | Redacted diagnostic JSONL export generated only by **Export Session Data**. |

Rolling 24-hour, 7-day, and 30-day totals are calculated from `session-ledger.json`. Exact usage-based costs come from `session.shutdown.data.totalNanoAiu`, with summed `session.shutdown.data.modelMetrics.*.totalNanoAiu` as fallback. Live open sessions are maintained from statusline `session_id` plus `ai_used.total_nano_aiu`; stale open sessions older than 7 days become `auto_closed`, preserving any live usage-based total or using a low-confidence token estimate when no cost was captured. Usage-based billing started on 2026-06-01, so older pay-per-message totals are ignored; retained pre-cutover token telemetry can be estimated from local post-cutover model rate profiles or the built-in GitHub pricing fallback and shown as a historical equivalent under current usage-based rates when available. The interactive `/cost` overview labels cost since June 1, 2026 separately from earlier historical estimates, bases averages/forecasts on the actual retained coverage window, and renders a six-month calendar with blank pre-data days and dash-filled no-spend days after local data begins. These windows are local Copilot CLI session telemetry, not account-wide Copilot billing totals.

Runtime display state that used to live in `sessions/*.json` is stored under the ledger's top-level `runtime` map. It keeps only values needed for reconciliation, context/rate display, next-message estimates, and last-message formatting. Derived window totals are not persisted there; they are recalculated from `sessions` each render.

First-run and startup backfill use local `~/.copilot/session-state/*/events.jsonl` files for new sessions within the 180-day horizon and for known sessions whose event-file metadata changed or was never stored. The parser is streaming and whitelist-only: it keeps timestamps, shutdown AIU, model AIU, compaction/usage-event AIU, token/request summaries, and file metadata, but not prompts, responses, transcript text, paths, tool arguments, or source code. `~/.copilot/session-store.db` contains useful session/turn/checkpoint metadata but no cost ledger. JSONL records are Copilot CLI session scoped, format-version dependent, CLI-only telemetry; they improve local 24h/7d/30d continuity and the `/cost` 60d/90d/180d overview ranges, but are not `/usage` account billing data.

`assistant.usage` and `session.usage_info` are ephemeral event streams, not replayable history. If the extension process stops before a turn reaches `session.idle`, that in-flight turn may not be reconstructable; persisted state is the durable source between restarts.

The extension runtime reads context from `session.usage_info` camelCase fields such as `currentTokens` and `tokenLimit`. The statusline runtime reads snake_case fields from stdin, such as `current_context_tokens` and `displayed_context_limit`, while tolerating known camelCase and alternate spellings.

When Copilot passes the shared `~/.copilot/session-state` root to the statusline command, the runtime combines it with `session_id` before deriving the plugin-data session key. This keeps parallel terminal sessions isolated, but it does not identify a durable conversation.

## Extension system notes

`copilot-cost` is packaged as a Copilot plugin at `plugins/copilot-cost`. The plugin bundles the native extension under `extensions/copilot-cost/` and owns the install workflow through the `ext-cost-setup` skill plus scripts in `scripts/`.

Copilot CLI discovers native extensions from project `.github/extensions/<name>/extension.mjs` and user `~/.copilot/extensions/<name>/extension.mjs` paths.

The setup script installs a generated user-scoped shim at `~/.copilot/extensions/copilot-cost/extension.mjs` that imports the bundled plugin extension by absolute file URL. It refuses to overwrite unmanaged files and replaces the older symlink layout only when the symlink plausibly points at a previous `copilot-cost` install. The statusline command does not create a product-specific folder under `~/.copilot`; it calls the bundled extension entrypoint inside the installed plugin.

Installer metadata and runtime accounting state are written to `COPILOT_PLUGIN_DATA` when Copilot provides it, with `~/.copilot/plugin-data/copilot-extensions/copilot-cost` as the fallback. Both the native extension process and standalone statusline command use this shared plugin-data location.

The extension API and discovery behavior are not fully documented on docs.github.com. Current behavior is based on the CLI runtime and examples, so keep the entrypoint conservative and re-check conventions when upgrading the CLI.

Reloading extensions with `/clear`, a new session, or the agent environment's extension reload tool kills and re-forks extension processes. There is no hot module patching; module state resets on reload. In current Copilot CLI, `/extensions` opens a menu with **manage** and **mode** options rather than a documented `/extensions reload` subcommand.
