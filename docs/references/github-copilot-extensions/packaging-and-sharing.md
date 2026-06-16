# Packaging and sharing native Copilot CLI extensions

Copilot CLI 1.0.62 and newer can load native extensions shipped inside installed plugins. For `copilot-cost`, that is the supported distribution path; no user-scoped shim, wrapper, symlink, or copied extension file is required.

## Current discovery targets

Native extensions can be discovered from:

```text
.github/extensions/<name>/extension.mjs
~/.copilot/extensions/<name>/extension.mjs
<installed-plugin>/extensions/<name>/extension.mjs
```

`copilot-cost` uses the plugin-shipped path:

```text
<installed-plugin>/extensions/copilot-cost/extension.mjs
```

Project and user extension paths still exist for local/project-specific extensions, but they are not part of the `copilot-cost` install flow.

## Current `copilot-cost` package shape

1. The repository exposes a Copilot plugin marketplace at `.github/plugin/marketplace.json`.
2. The installable plugin lives under `plugins/copilot-cost/`.
3. The plugin bundles its native extension under `plugins/copilot-cost/extensions/copilot-cost/extension.mjs`.
4. Users install or update through Copilot plugin commands:

```sh
copilot plugin marketplace add RogueKernel/copilot-extensions
copilot plugin install copilot-cost@copilot-extensions
copilot plugin marketplace update copilot-extensions
copilot plugin update copilot-cost
```

On first run, the bundled extension configures Copilot's custom footer/statusline settings so the footer process runs:

```text
node <installed-plugin>/extensions/copilot-cost/extension.mjs --statusline
```

The statusline command points directly at the installed plugin entrypoint. The extension no longer writes a generated `~/.copilot/extensions/copilot-cost/extension.mjs` shim.

## Migration behavior

Older `copilot-cost` versions used a generated user-scoped shim. Current startup removes that legacy shim only when it contains the known generated marker, so unmanaged user extensions are left alone.

Plugin updates no longer depend on rewriting a user extension file. After `copilot plugin update copilot-cost`, users should open a new Copilot CLI session or run `/clear` so the updated plugin-bundled extension is loaded.

## Current risks

- Copilot CLI 1.0.62 or newer is required for plugin-shipped native extension discovery.
- First-run setup still updates `~/.copilot/settings.json` for `statusLine.command`, `footer.showCustom`, and `experimental`; uninstall must restore any prior managed statusline/footer settings.
- The statusline command requires Node.js 18+ to be available as `node`.
- `/clear`, starting a new session, full restart, and the agent environment's internal reload tool may not be equivalent across CLI versions. Current user-facing `/extensions` opens **manage** and **mode** menus, not a documented reload subcommand.
