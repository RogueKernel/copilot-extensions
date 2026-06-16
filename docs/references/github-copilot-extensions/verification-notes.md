# Verification notes

This file tracks claims from the htek.dev article and whether they were verified for the local environment.

## Verified for Copilot CLI 1.0.60

| Claim | Status | Evidence |
| --- | --- | --- |
| Native extensions run as separate Node.js processes over JSON-RPC/stdio | Verified | Bundled SDK docs: `copilot-sdk/docs/extensions.md` |
| Project extensions live under `.github/extensions/<name>/extension.mjs` | Verified | Bundled SDK docs and current `copilot-cost` runtime |
| User extensions live under the user Copilot extensions directory | Verified | Bundled SDK docs; local repo uses `~/.copilot/extensions` |
| Entry file must be named `extension.mjs` | Verified | Bundled SDK docs |
| Only `.mjs`/ES modules are supported | Verified | Bundled SDK docs |
| CLI provides the `@github/copilot-sdk` resolver | Verified | Bundled SDK docs and current extension behavior |
| Use `session.log()` instead of stdout | Verified | Bundled SDK docs |
| Custom tools include name, description, JSON Schema parameters, and handler | Verified | Bundled SDK docs |
| Tool names must be globally unique | Verified | Bundled SDK docs |
| Hooks include pre/post tool, prompt, session start/end, and error handling | Verified | Bundled SDK docs |
| `session.on()` subscribes to events and returns unsubscribe | Verified | Bundled SDK docs |
| Extension reload is available to agents through `extensions_reload({})` | Verified | Local extension tool and bundled SDK docs |
| `session.ui` elicitation and confirm/select/input APIs exist | Type-verified | `copilot-sdk/session.d.ts`, `copilot-sdk/types.d.ts` |
| Slash command registration exists in SDK config | Type-verified | `CommandDefinition` and `commands?: CommandDefinition[]` in `types.d.ts` |
| `skipPermission` exists for tools | Type-verified | `Tool.skipPermission` in `types.d.ts` |
| `onPermissionRequest` exists for extensions | Type-verified | `JoinSessionConfig` in `extension.d.ts` |
| `session.setModel`, `session.abort`, `session.getEvents`, and `session.disconnect` exist | Type-verified | `session.d.ts` |
| `systemMessage`, `mcpServers`, `customAgents`, `infiniteSessions`, and `provider` exist in session config | Type-verified | `types.d.ts` |
| Copilot CLI plugins support direct GitHub subdirectory install specs | Officially verified | Copilot CLI plugin reference and `copilot plugin install --help` |
| GitHub-owned example repos separate `plugins/` and `extensions/` | Public-example verified | `github/awesome-copilot` |
| All current GitHub-owned `awesome-copilot/extensions/` examples are canvas-first native SDK extensions | Public-example verified | Reviewed `accessibility-kanban`, `color-orb`, `diagram-viewer`, `feedback-themes`, `gesture-review`, and `where-was-i` at commit `a94b92d` |
| Public native-extension repos use `~/.copilot/extensions/<name>/extension.mjs` for user-scoped installs | Public-example verified | `DamianEdwards/copilot-cli-cost`, `microsoft/copilot-brag-sheet`, `samcharles93/openagent`, `shsolomo/myelin`, and `htekdev/copilot-self-restart` |
| SDK `session` scope is a Copilot CLI terminal instance, not a durable conversation | Locally verified | The active `session_id` and workspace are tied to the running Copilot terminal process. Session-scoped usage metrics should not define durable conversation or account boundaries. The native extension can use `session.rpc.usage.getMetrics().totalNanoAiu` to reconcile pending runtime cost because local usage events can undercount; the standalone statusline command now renders cached summary state only. |
| Built-in `/usage` displays broader account/activity data | Locally observed | Screenshot showed "Activity · last 180 days", total messages, changes, AI Credits, and token totals including cached and reasoning tokens. No native-extension SDK/RPC reader for this TUI output has been verified. |
| `account.getQuota` returns quota snapshots, not historical spend windows | Locally verified | Direct SDK call returned current quota/reset-window snapshots (`chat`, `completions`, `premium_interactions`) with entitlement/used/remaining fields. External SDK probing can trigger macOS keychain auth prompts. |
| Local `session-state` event logs contain historical session telemetry | Locally verified | `~/.copilot/session-state/*/events.jsonl` includes `session.shutdown.data.totalNanoAiu` and `session.shutdown.data.modelMetrics.<model>.totalNanoAiu` in newer records, plus token/request metadata. This is CLI session-scoped telemetry, not an account-wide or conversation ledger. |

## Partially verified or version-sensitive

| Claim | Status | Notes |
| --- | --- | --- |
| `/extensions reload`, `/extensions enable`, `/extensions disable`, `/extensions info` interactive commands exist | Stale/disputed | The htek.dev article lists these subcommands, but current Copilot CLI shows `/extensions` as a menu with **manage** and **mode** options. The agent environment exposes internal tools named `extensions_reload` and `extensions_manage`, but those are not proof of user-facing slash subcommands. |
| Experimental mode or `experimental_flags` are required for native extensions/statusline | Version-sensitive | `DamianEdwards/copilot-cli-cost` configures `"experimental": true` and `experimental_flags: ["EXTENSIONS", "STATUS_LINE"]`; local CLI 1.0.60 runs this repo's project extension without proving those settings are required. Treat as install-time compatibility work, not a universal rule. |
| Runtime behavior of SDK-registered slash commands | Version-sensitive | Type definitions support commands; user-visible command palette behavior depends on CLI/TUI support. |
| Runtime behavior of `session.ui` | Capability-gated | Check `session.capabilities.ui?.elicitation` before calling. |

## Disputed or likely outdated

| Claim | Status | Notes |
| --- | --- | --- |
| There is "zero public documentation" | Outdated/overstated for this environment | The installed CLI includes SDK docs, and official docs cover plugins. Public official docs for native extensions are still sparse. |
| Native extensions require experimental mode | Not supported by local evidence | Local CLI 1.0.60 has general experimental mode, but extensions are running in this repo without an extension-specific setting found in help. |

## Important distinction confirmed

The relevant official docs for plugin distribution are the Copilot CLI plugin docs, which use `copilot plugin install`.

## Article availability note

The htek.dev article was supplied by the user and summarized into these reference docs, but multiple research agents later reported that the article URL and tested variants returned 404 or unrelated htek.dev content. Treat this as a reminder that the article is not an authoritative, stable source; keep local SDK docs, official Copilot CLI/plugin docs, and source-code verification as primary references.

## Open questions

1. Are article-listed `/extensions` subcommands from an older Copilot CLI build, or were they inferred from internal agent tools?
2. Is the hook overwrite bug still present in CLI 1.0.60?
3. Which advanced `joinSession` options are stable in CLI 1.0.60?
4. Is there any official roadmap for native extensions as plugin components?
