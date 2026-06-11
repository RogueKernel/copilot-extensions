# Link inventory from the htek.dev guide

This inventory tracks links extracted from the htek.dev Copilot CLI extensions guide. Each linked source should be treated as a lead until verified against source code, official docs, or local CLI behavior.

## Official GitHub docs and repositories

| Label | URL | Status | Notes |
| --- | --- | --- | --- |
| MCP servers | https://docs.github.com/en/copilot/concepts/extensions | Pending | Distinguishes MCP/Copilot Extensions product from local CLI native extensions. |
| Copilot Extensions | https://docs.github.com/en/copilot/how-tos/use-copilot-extensions/set-up-copilot-extensions | Pending | GitHub App/server-side Copilot Extensions, not local CLI native extensions. |
| Copilot SDK | https://github.com/github/copilot-sdk | Pending | Primary public SDK source to compare against bundled SDK docs/types. |
| `github/awesome-copilot` native extensions | https://github.com/github/awesome-copilot/tree/main/extensions | Verified | GitHub-owned native SDK extension examples. Reviewed six examples at commit `a94b92d`: `accessibility-kanban`, `color-orb`, `diagram-viewer`, `feedback-themes`, `gesture-review`, and `where-was-i`. |
| `github/copilot-cli#2076` | https://github.com/github/copilot-cli/issues/2076 | Pending | Article cites this for hook overwrite behavior. Verify accessibility/status. |
| `github/copilot-cli#2142` | https://github.com/github/copilot-cli/issues/2142 | Pending | Article cites this for `onSessionStart` context behavior before CLI 1.0.11. Verify accessibility/status. |

## Related non-GitHub docs

| Label | URL | Status | Notes |
| --- | --- | --- | --- |
| Claude Code hooks | https://claude.com/blog/how-to-configure-hooks | Pending | Useful contrast only; not evidence for Copilot CLI native extension behavior. |

## htek.dev technical articles

| Label | URL | Status | Notes |
| --- | --- | --- | --- |
| Complete Copilot CLI extensions guide | https://htek.dev/articles/github-copilot-cli-extensions-complete-guide | Unavailable/unverified | Later research found this URL and tested variants returned 404 or unrelated content. Treat article-derived claims as historical leads only; the article-listed `/extensions list|enable|disable|reload|info` subcommands are disputed by current menu behavior. |
| Extension cookbook examples | https://htek.dev/articles/copilot-cli-extensions-cookbook-examples | Unavailable/unverified | Article-derived claim of 16 production-ready examples; source URL should be rechecked before use. |
| Agent hooks / layer rules | https://htek.dev/articles/agent-hooks-controlling-ai-codebase | Unavailable/unverified | Historical lead for hook design and architecture enforcement; source URL should be rechecked before use. |
| Self-restart extension | https://htek.dev/articles/copilot-cli-self-restart-extension | Unavailable/unverified | Historical lead for lifecycle/session-control patterns; source URL should be rechecked before use. |
| Agent harnesses | https://htek.dev/articles/agent-harnesses-controlling-ai-agents-2026 | Unavailable/unverified | Historical higher-level architecture lead; source URL should be rechecked before use. |
| Agent mesh communication | https://htek.dev/articles/agent-mesh-cross-session-communication-copilot-cli | Unavailable/unverified | Historical lead for cross-session communication patterns; source URL should be rechecked before use. |
| Home assistant platform | https://htek.dev/articles/copilot-home-assistant-ai-runs-my-household | Unavailable/unverified | Historical real-world extension platform lead; source URL should be rechecked before use. |
| Standalone SDK deep dive | https://htek.dev/articles/github-copilot-sdk-agents-for-every-app | Unavailable/unverified | Historical lead for distinguishing standalone SDK from native CLI extensions; source URL should be rechecked before use. |
| Telegram bridge | https://htek.dev/articles/copilot-cli-telegram-bridge-mobile-ai-terminal | Unavailable/unverified | Historical mobile/remote-control extension lead; source URL should be rechecked before use. |
| OpenClaw comparison | https://htek.dev/articles/who-needs-openclaw-copilot-cli-extensions | Unavailable/unverified | Historical extension-vs-framework lead; source URL should be rechecked before use. |
| CI monitor | https://htek.dev/articles/ci-monitor-extension-agent-ci-feedback-loop | Unavailable/unverified | Historical feedback-loop lead; source URL should be rechecked before use. |

## Real-world source repositories

| Label | URL | Status | Notes |
| --- | --- | --- | --- |
| `htekdev/rocha-family` | https://github.com/htekdev/rocha-family | 404 | Research agents could not access this repository; likely private, renamed, or removed. |
| `htekdev/copilot-self-restart` | https://github.com/htekdev/copilot-self-restart | Verified | Minimal native extension installed by manual copy into project or user extension directories. |
| `DamianEdwards/copilot-cli-cost` | https://github.com/DamianEdwards/copilot-cli-cost | Verified | Closest public peer: marketplace/direct plugin install plus generated extension shim plus statusline/settings configurator. |
| `microsoft/copilot-brag-sheet` | https://github.com/microsoft/copilot-brag-sheet | Verified | User-scoped native extension installed by shell/PowerShell script, git clone/copy, or npm global installer. |
| `samcharles93/openagent` | https://github.com/samcharles93/openagent | Verified | Managed checkout plus generated self-updating native wrapper and Node launcher. |
| `shsolomo/myelin` | https://github.com/shsolomo/myelin | Verified | TypeScript/esbuild native extension with setup tooling and user/project install modes. |

## Lower priority / not technical evidence

| Label | URL | Status | Notes |
| --- | --- | --- | --- |
| htek.dev newsletter | https://htek.dev/newsletter | Low priority | Not needed for technical reference unless it links source material. |
| Agentic Development Blueprints | https://htek.dev/blueprints | Low priority | Commercial/resource page; inspect only if it includes concrete extension docs/source. |
