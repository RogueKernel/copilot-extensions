# copilot-cost

`copilot-cost` is a GitHub Copilot CLI extension that shows cost, context, cache, cumulative session usage, and rolling usage while you work.

It renders a short summary after assistant messages and/or in the statusline footer, preferring live Copilot AI-credit usage data and using retained token/model metadata only when authoritative AIU totals are unavailable.

It has no npm runtime or development dependencies; Copilot CLI provides the extension runtime package. That keeps the installed supply-chain surface small.

## Preview

![copilot-cost statusline preview](../../docs/assets/copilot-cost/copilot-cost-preview.png)

After each assistant response:

```text
[21:00] +£0.03 in 15.4s · Next >= [£0.03 - £0.14] · Cache 96% read
```

| Example | Name | Description |
| --- | --- | --- |
| `[21:00]` | Finish time | When the assistant response finished. |
| `+£0.03 in 15.4s` | Last message | Observed cost and elapsed time for the last assistant message. |
| `Next >= [£0.03 - £0.14]` | Next message est. | Estimated minimum cost range for the next message. The first value is the best case: most context is still cached. The second is the stale-cache case: context is charged as uncached input or cache write, depending on model pricing. Both add average recent uncached input/output work from the last 5 messages. |
| `Cache 96% read` | Cache read rate | Percentage of input served from cache. Cache write rate is also shown when cache writes are charged. |

Footer/statusline:

```text
Total £1.24 · Ctx 48% (96k/200k) · Sess £1.4 · 24h £0 · 7d £2 · 30d £8
```

| Example | Name | Description |
| --- | --- | --- |
| `Total £1.24` | Conversation cost | Best-known current conversation total: local assistant/compaction usage stays pending until Copilot's official statusline counter catches up. |
| `Ctx 48% (96k/200k)` | Context usage | Current context-window usage, shown as a percentage and as used/available tokens. |
| `Sess £1.4` | Copilot session total | Copilot's cumulative official running cost for the current Copilot CLI session. |
| `24h £0` | 24h local CLI cost | Session-ledger cost in the last 24 hours. |
| `7d £2` | 7d local CLI cost | Session-ledger cost in the last 7 days. |
| `30d £8` | 30d local CLI cost | Session-ledger cost in the last 30 days. |

`Sess` is the cumulative live official Copilot CLI session counter, shown in the same cumulative totals group as the 24h/7d/30d values. The same counter reconciles locally pending `Total` and keeps the current session ledger up to date because local events can miss tool and sub-agent work, but Copilot CLI sessions are still terminal instances rather than conversation or account boundaries. Rolling 24h/7d/30d totals come from local Copilot CLI session telemetry, so they are not account-wide Copilot billing totals. Usage-based billing started on 2026-06-01, so earlier pay-per-message totals are ignored and retained token telemetry is valued as a historical equivalent under the current usage-based model when a local post-June rate profile or built-in GitHub pricing fallback is available. The live footer can also include Copilot CLI status data such as model, effort level, and current context percentage.

## Documentation

| Document | Purpose |
| --- | --- |
| [`Usage`](../../docs/copilot-cost/usage.md) | Install, configure, and customize output formats. |
| [`Architecture`](../../docs/copilot-cost/architecture.md) | Runtime flow, accounting model, persistence, and extension-system behavior. |
| [`Development`](../../docs/copilot-cost/development.md) | Commands, tests, and contributor conventions. |

## Quick install

Make sure Copilot CLI is up to date:

```sh
copilot update
```

Make sure Node.js 18 or newer is installed and available as `node`. The first-run footer setup writes a `statusLine.command` that calls `node` directly.

Add this repository as a plugin marketplace, then install `copilot-cost`:

```sh
copilot plugin marketplace add RogueKernel/copilot-extensions
copilot plugin install copilot-cost@copilot-extensions
```

Open Copilot CLI with experimental extension support enabled:

```sh
copilot --experimental
```

`copilot --experimental` opens an interactive Copilot session and stays open, so do not chain another install command after it with `&&`. If you are already inside Copilot, make sure experimental mode is on with `/experimental on`.

Copilot CLI 1.0.62 and newer loads native extensions shipped by installed plugins. On first run, `copilot-cost` configures `statusLine.command` to call the plugin-bundled extension directly with `node`, enables `footer.showCustom`, and removes the old generated user shim if it was created by a previous setup version.

Restart Copilot CLI, start a new session, or run `/clear`. If the extension does not appear, run `/extensions`, choose **manage**, and enable `copilot-cost`.

See [`usage.md`](../../docs/copilot-cost/usage.md) for full install, configuration, defaults, and format-token details.

## Update

```sh
copilot plugin marketplace update copilot-extensions
copilot plugin update copilot-cost
```

## Uninstall

Open `/cost`, choose **Settings**, then choose **Uninstall**. That restores any prior statusline/footer settings.

Afterward, remove the plugin package if you no longer want it installed:

```sh
copilot plugin uninstall copilot-cost
```

If you added this repository only for `copilot-cost`, you can also run:

```sh
copilot plugin marketplace remove copilot-extensions
```

## Quick configure

Use `/cost` for an interactive overview of recent local cost history. The top-level view shows current totals, 24h/7d/30d/60d/90d/180d cumulative totals, cost by calendar month for the current and previous four months, a six-month month-block calendar with blank pre-data days and dash-filled no-spend days after local data begins, usage-based billing cost since June 1, 2026, historical equivalent estimates for earlier retained telemetry, and run-rate analysis based on the available local data coverage. Choose **Info** for metric/source details or **Settings** to configure what the extension shows, where it appears, which unit to use, how summaries are formatted, export debug data, clear plugin data, or restore prior footer settings.

![copilot-cost overview dashboard](../../docs/assets/copilot-cost/copilot-cost-dashboard.png)

Direct commands:

```text
/cost both
/cost footer
/cost message
/cost off
/cost gbp
/cost usd
/cost credits
```

On first run, `copilot-cost` configures Copilot CLI's built-in Custom Footer through `statusLine.command` and enables `footer.showCustom`. If another statusline command already exists, it is replaced with `copilot-cost` and saved so `/cost` > **Settings** > **Uninstall** can restore it.

The Settings view also includes maintenance actions. **Export Session Data** writes `COPILOT_COST_DEBUG.jsonl` to the current working directory with one redacted JSONL record per discovered local Copilot CLI session: event-file metadata, event/type counts, token/cost/model summaries, and any matching ledger record. It excludes prompts, responses, transcript text, tool arguments, source code, and absolute local paths; event-file paths are normalized to session-state labels. **Clear Plugin Data** removes the `copilot-cost` plugin-data folder, including settings, session ledger history, runtime totals, export state, and managed statusline state. It does not remove the plugin package or Copilot settings.

## Persisted data

`copilot-cost` persists small JSON files so runtime accounting state survives extension reloads and Copilot CLI restarts. It stores cost/accounting state only; it does not persist prompts, responses, transcript text, file paths from your work, or source code.

| File | Scope | Why it exists |
| --- | --- | --- |
| `~/.copilot/plugin-data/copilot-extensions/copilot-cost/settings.json` | Global user | Saves display mode, unit, and custom format strings. |
| `~/.copilot/plugin-data/copilot-extensions/copilot-cost/session-ledger.json` | Global user | Single cost/state file. Stores compact per-session records for rolling 24h/7d/30d totals, the 180-day overview, and lean runtime display/reconciliation state. |
| `~/.copilot/plugin-data/copilot-extensions/copilot-cost/install-state.json` | Plugin installer | Stores the prior statusline/footer settings so the `/cost` uninstall flow can restore them. |
| `./COPILOT_COST_DEBUG.jsonl` | Current working directory, on demand | Redacted diagnostic export for debugging session discovery and cost extraction. Created only by **Export Session Data**. |

When Copilot provides `COPILOT_PLUGIN_DATA`, setup and runtime state use that directory instead of the fallback path above. When Copilot passes the shared `~/.copilot/session-state` root to the statusline command, `copilot-cost` combines it with the active `session_id` before deriving the plugin-data session key. That keeps parallel terminal sessions isolated, but it should not be interpreted as a user conversation boundary.

Example settings file:

```json
{
  "mode": "both",
  "unit": "gbp",
  "messageFormat": "[{time}] {message_group} · {next_group} · {cache_group}",
  "footerFormat": "{total_group} · {context_group} · {windows_group}"
}
```

Example session ledger file:

```json
{
  "version": 1,
  "lastSyncAt": 1781008000000,
  "sessions": {
    "00000000-0000-4000-8000-000000000000": {
      "id": "00000000-0000-4000-8000-000000000000",
      "state": "closed",
      "totalNanoAiu": 274586275000,
      "source": "shutdown",
      "firstSeenAt": 1781000000000,
      "lastSeenAt": 1781007900000,
      "lastUpdatedAt": 1781007900000,
      "closedAt": 1781007900000
    }
  },
  "runtime": {
    "workspace-38595a0d0908": {
      "totalUsd": 1.52,
      "sessionUsd": 1.40,
      "officialSegmentUsd": 1.40,
      "pendingUsd": 0.12,
      "contextTokens": 63000,
      "contextTokenLimit": 264000
    }
  }
}
```

## Local validation

Run commands from this directory:

```sh
cd plugins/copilot-cost/extensions/copilot-cost
npm test
npm run check
npm run smoke:statusline
npm run validate
```

Run one test file:

```sh
node --test test/unit/cost.test.mjs
```

Do not install `@github/copilot-sdk`; Copilot CLI provides it to extension child processes.

## Developer local install

These commands are for maintainers testing local, unpushed changes. End users should use **Quick install** and **Update** above.

From any terminal, register this local checkout as a marketplace and install from it:

```sh
REPO="/path/to/copilot-extensions"
copilot plugin marketplace remove copilot-extensions 2>/dev/null || true
copilot plugin marketplace add "$REPO"
copilot plugin install copilot-cost@copilot-extensions
copilot --experimental
```

Inside Copilot CLI, run `/clear` or start a new session, then use `/cost`.
