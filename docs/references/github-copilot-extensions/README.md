# GitHub Copilot CLI native extensions

This folder is a working reference for **native GitHub Copilot CLI extensions**: local `.mjs` extensions discovered from `.github/extensions/` or `~/.copilot/extensions/`.

Version-specific claims in this folder are snapshots from the verification environment named in each file. This checkout currently has Copilot CLI 1.0.61 installed; re-run local verification before treating older 1.0.60 observations as current compatibility guarantees.

These are not the same as:

- **GitHub CLI (`gh`) extensions**.
- **GitHub Copilot Extensions**, the GitHub App/server integration product.
- **Copilot CLI plugins**, installed with `copilot plugin install`; plugins can ship skills, agents, hooks, MCP/LSP config, and other plugin components, but they do not currently install native `.github/extensions/<name>/extension.mjs` extensions as a first-class plugin component.

## Source status

| Source | Status | Use in this folder |
| --- | --- | --- |
| Local SDK docs bundled with Copilot CLI 1.0.60 | Most authoritative for the 1.0.60 verification snapshot | Primary reference |
| Local SDK `.d.ts` files bundled with Copilot CLI 1.0.60 | Authoritative type surface for that snapshot | Used to verify advanced APIs |
| `copilot help config`, `copilot help commands`, and local CLI behavior | Authoritative for the CLI version being tested | Verification notes |
| GitHub Copilot CLI plugin docs | Official for plugins, not native extensions | Used to distinguish plugins from extensions |
| GitHub-owned `github/awesome-copilot` examples | Public examples of plugins and SDK extensions | Secondary implementation reference |
| htek.dev guide | Unofficial and currently unavailable/unverified | Historical lead only |

## Files

- [`architecture-and-discovery.md`](architecture-and-discovery.md) — process model, discovery paths, lifecycle, and file layout.
- [`authoring-workflow.md`](authoring-workflow.md) — scaffold/edit/reload/inspect workflow and minimal skeleton.
- [`tools-and-permissions.md`](tools-and-permissions.md) — custom tools, return types, permissions, and stdout rules.
- [`hooks-and-events.md`](hooks-and-events.md) — lifecycle hooks, event subscriptions, and when to use each.
- [`session-ui-and-control.md`](session-ui-and-control.md) — session messaging, logging, UI elicitation, and session control APIs.
- [`plugins-vs-extensions.md`](plugins-vs-extensions.md) — how Copilot CLI plugins differ from native SDK extensions.
- [`examples-and-distribution.md`](examples-and-distribution.md) — public examples and practical distribution patterns.
- [`packaging-and-sharing.md`](packaging-and-sharing.md) — observed and speculative ways native extensions are packaged, shared, and deployed.
- [`link-inventory.md`](link-inventory.md) — links extracted from the htek.dev guide and research status.
- [`verification-notes.md`](verification-notes.md) — verified, unverified, and disputed claims from the article.

## Short conclusion

Native Copilot CLI extensions are real in the current CLI, but the public, official documentation is much thinner than the plugin documentation. The installed CLI bundles SDK docs and exposes extension management tools in the agent environment. Treat blog-post claims as useful leads, not as authoritative API guarantees.
