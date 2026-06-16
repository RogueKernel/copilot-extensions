# Copilot extensions

A small collection of GitHub Copilot CLI extensions that make day-to-day agent work more visible, controllable, and useful.

This repo currently contains one plugin, but it is structured as a Copilot CLI marketplace: each installable plugin lives under `plugins/<name>/` and can bundle a native extension where needed.

## Plugins

### copilot-cost

[`copilot-cost`](plugins/copilot-cost) shows Copilot CLI message cost, conversation cost, cumulative Copilot session total, context usage, cache health, and rolling 24h/7d/30d usage while you work.

It gives you a lightweight answer to: "What did that response cost?", "How much has this conversation used?", "How much has this Copilot session used?", "How full is my context?", and "Is caching helping?"

It has no npm runtime or development dependencies; Copilot CLI provides the extension runtime package. That keeps the installed supply-chain surface small.

![copilot-cost statusline preview](docs/assets/copilot-cost/copilot-cost-preview.png)

#### Install

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

Restart Copilot CLI, start a new session, or run `/clear`, then run `/cost` to configure or confirm it loaded.

Copilot CLI also discovers native extensions from:

- `.github/extensions/<extension-name>/extension.mjs` in a project
- `~/.copilot/extensions/<extension-name>/extension.mjs` for user-wide installs

#### Update

```sh
copilot plugin marketplace update copilot-extensions
copilot plugin update copilot-cost
```

#### Uninstall

Open `/cost`, choose **Settings**, then choose **Uninstall**. That restores any prior statusline/footer settings.

Afterward, remove the plugin package if you no longer want it installed:

```sh
copilot plugin uninstall copilot-cost
```

If you added this repository only for `copilot-cost`, you can also remove the marketplace:

```sh
copilot plugin marketplace remove copilot-extensions
```

#### After-message output

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

#### Footer/statusline output

```text
Total £1.24 · Ctx 48% (96k/200k) · Sess £1.4 · 24h £0 · 7d £2 · 30d £8
```

| Example | Name | Description |
| --- | --- | --- |
| `Total £1.24` | Conversation cost | Best-known current conversation total: local assistant/compaction usage stays pending until the extension captures Copilot's official session counter. |
| `Ctx 48% (96k/200k)` | Context usage | Current context-window usage, shown as a percentage and as used/available tokens. |
| `Sess £1.4` | Copilot session total | Copilot's cumulative official running cost for the current Copilot CLI session. |
| `24h £0` | 24h local session cost | Session-ledger cost in the last 24 hours. |
| `7d £2` | 7d local session cost | Session-ledger cost in the last 7 days. |
| `30d £8` | 30d local session cost | Session-ledger cost in the last 30 days. |

`Sess` is the cumulative live official Copilot CLI session counter, shown in the same cumulative totals group as the 24h/7d/30d values. The native extension captures that counter and reconciles locally pending `Total` in the lightweight summary state because local events can miss tool and sub-agent work; the footer/statusline command only reads that summary state and renders it. Copilot CLI sessions are terminal instances rather than conversation or account boundaries. Rolling 24h/7d/30d totals come from retained local session telemetry cached after ledger sync, not from live RPC refreshes or account-wide Copilot billing totals. Full sync also folds current summary runtime totals for still-open sessions into the ledger because active JSONL logs can lack live cost until shutdown. Startup and `/cost` force a sync; completed turns refresh the shared rolling-window cache only when its summary timestamp is more than five minutes old, so concurrent sessions normally catch up within a few minutes without syncing after every turn. For telemetry before June 1, 2026, old pay-per-message totals are ignored and retained token telemetry is valued as a historical equivalent under the current usage-based model when a local post-June rate profile or built-in GitHub pricing fallback is available. Older stale sessions without a shutdown event can be estimated from retained assistant-message output tokens when no richer usage event exists; those appear as low-confidence `Stale [Token]` diagnostics.

#### Configure

Use `/cost` interactively for a cost overview with local history, 24h/7d/30d/60d/90d/180d cumulative totals, recent calendar-month cost, a six-month month-block calendar with blank pre-data days and dash-filled no-spend days after local data begins, usage-based billing cost since June 1, 2026, historical equivalent estimates for earlier retained telemetry, retained session cost split by Copilot CLI vs VS Code, and run-rate analysis based on the available local data coverage. Choose **Info** for metric/source details or **Settings** to configure what the extension shows, where it appears, which unit it uses, how summaries are formatted, export debug data, clear plugin data, or restore prior footer settings.

![copilot-cost overview dashboard](docs/assets/copilot-cost/copilot-cost-dashboard.png)

The Settings view includes display, unit, format, export, clear-data, and uninstall controls. **Export Session Data** writes `COPILOT_COST_DEBUG.jsonl` to the current working directory with one redacted JSONL record per discovered local session or ledger row: event-file metadata when available, event/type counts, token/cost/model summaries, and any matching ledger record. It excludes prompts, responses, transcript text, tool arguments, source code, and absolute local paths; event-file paths are normalized to session-state labels. **Clear Plugin Data** removes the `copilot-cost` plugin-data folder, including settings, session ledger history, summary state, export state, and managed statusline state. It does not remove the plugin package or Copilot settings.

![copilot-cost formatting settings](docs/assets/copilot-cost/copilot-cost-format-settings.png)

Direct commands are also available:

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

#### More documentation

| Document | Purpose |
| --- | --- |
| [`Usage`](docs/copilot-cost/usage.md) | Install, configure, and customize output formats. |
| [`Architecture`](docs/copilot-cost/architecture.md) | Runtime architecture, persistence, and extension-system notes. |
| [`Development`](docs/copilot-cost/development.md) | Local commands, tests, and contributor conventions. |

## Repository structure

This repository is a Copilot CLI plugin marketplace. The marketplace manifest lives at `.github/plugin/marketplace.json`; plugin packages live under `plugins/`; `copilot-cost` bundles its native extension under `plugins/copilot-cost/extensions/copilot-cost/`.

## Development

Common commands from the repository root:

```sh
cd plugins/copilot-cost/extensions/copilot-cost
npm test
npm run check
npm run smoke:statusline
npm run validate
```

### Install from a local checkout

These commands are for maintainers testing local, unpushed changes. End users should use the install and update commands above.

From any terminal, register this local checkout as a marketplace and install from it:

```sh
REPO="/path/to/copilot-extensions"
copilot plugin marketplace remove copilot-extensions 2>/dev/null || true
copilot plugin marketplace add "$REPO"
copilot plugin install copilot-cost@copilot-extensions
copilot --experimental
```

Inside Copilot CLI, run `/clear` or start a new session, then use `/cost`.

To test without touching your real Copilot config, set isolated homes before the marketplace commands:

```sh
export COPILOT_HOME="$(mktemp -d)"
export COPILOT_CACHE_HOME="$COPILOT_HOME/cache"
```

See each plugin's README for usage, architecture notes, and test commands.
