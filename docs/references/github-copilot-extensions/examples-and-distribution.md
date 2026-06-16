# Examples and distribution patterns

This file collects examples found during verification. Treat public examples as implementation references, not as formal API contracts.

## GitHub-owned examples

The `github/awesome-copilot` repository has separate top-level areas for Copilot CLI plugins and SDK/native extensions:

- `plugins/` — Copilot CLI plugins using `plugin.json`, skills, agents, hooks, MCP/LSP config, and related plugin components.
- `extensions/` — SDK-style extensions using `extension.mjs` and `@github/copilot-sdk/extension`.

This separation is historical context. Copilot CLI 1.0.62 can load native extensions shipped inside installed plugins, while project/user native-extension paths still exist.

Examples reviewed at `github/awesome-copilot` commit `a94b92d`:

- `github/awesome-copilot/extensions/accessibility-kanban`
- `github/awesome-copilot/extensions/color-orb`
- `github/awesome-copilot/extensions/diagram-viewer`
- `github/awesome-copilot/extensions/feedback-themes`
- `github/awesome-copilot/extensions/gesture-review`
- `github/awesome-copilot/extensions/where-was-i`

The `color-orb` pattern imports from `@github/copilot-sdk/extension`, creates a canvas, and calls `joinSession({ canvases: [...] })`.

## Community examples

Examples reported by verification:

- `samcharles93/openagent` — TypeScript source compiled to ESM, then installed into `~/.copilot/extensions/<name>/extension.mjs` via a wrapper/delegation script.
- `DamianEdwards/copilot-cli-cost` — cost-estimation peer project using a Copilot plugin plus a generated user-extension shim and statusline/settings configurator.
- `microsoft/copilot-brag-sheet` — user-scoped native extension installed by shell/PowerShell scripts or npm global installer.
- `htekdev/copilot-self-restart` — minimal one-file native extension installed by manual copy.
- `shsolomo/myelin` — TypeScript native extension bundled with esbuild and installed through setup tooling.

The `openagent` wrapper pattern is similar to `copilot-cost`'s old plugin setup workaround: put something discoverable in the native extension path, then delegate to maintained code elsewhere.

OpenAgent's installer writes a generated native wrapper rather than a symlink. The wrapper imports a built bundle elsewhere, records a fingerprint, and can re-run setup if the wrapper is stale. This remains useful historical context for pre-1.0.62 environments.

The public cost-extension peer remains useful historical context for older CLI builds and migration behavior: it treats plugin install, native extension registration, and statusline configuration as separate setup steps. Current `copilot-cost` does not need that generated forwarder path because Copilot CLI can discover plugin-shipped native extensions directly.

## Distribution options for Copilot CLI native extensions

Current practical options:

1. **Project-scoped native extension**: commit `.github/extensions/<name>/extension.mjs` into a repository. It loads when Copilot CLI is run in that project.
2. **User-scoped native extension**: place or link code under `~/.copilot/extensions/<name>/extension.mjs`.
3. **Plugin-shipped native extension**: distribute a plugin containing `extensions/<name>/extension.mjs`; Copilot CLI 1.0.62 and newer loads it from the installed plugin.
4. **Legacy plugin wrapper**: distribute a plugin, then use a skill or installer to write a managed shim, copy files, or link code into the user extension path.

The fourth option is a workaround for older CLI versions or projects with custom installer needs.

## Plugin install paths

Copilot CLI plugin docs support both marketplace and direct install specs:

```sh
copilot plugin install plugin@marketplace
copilot plugin install OWNER/REPO
copilot plugin install OWNER/REPO:PATH/TO/PLUGIN
copilot plugin install ./local-plugin
```

Direct subdirectory installs are valid for plugins. On Copilot CLI 1.0.62 and newer, a plugin installed this way can also expose a bundled native SDK extension.
