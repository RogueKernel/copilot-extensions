# Plugins vs native extensions

Copilot CLI plugins and native Copilot CLI extensions are separate systems.

## Copilot CLI plugins

Official plugin docs cover:

- `copilot plugin install SPECIFICATION`
- plugin marketplaces
- plugin manifests (`plugin.json`)
- plugin component paths such as `skills`, `agents`, `commands`, `hooks`, `mcpServers`, and `lspServers`

Supported install specs include:

```text
plugin@marketplace
OWNER/REPO
OWNER/REPO:PATH/TO/PLUGIN
https://github.com/o/r.git
./local/path
```

Installed plugin locations are documented as:

- `~/.copilot/installed-plugins/MARKETPLACE/PLUGIN-NAME`
- `~/.copilot/installed-plugins/_direct/SOURCE-ID/`

## Native Copilot CLI extensions

Native extensions are discovered from:

- `.github/extensions/<name>/extension.mjs`
- `~/.copilot/extensions/<name>/extension.mjs`

They use `@github/copilot-sdk/extension` and run as child processes attached to the current CLI session.

## Can plugins install native extensions?

Current conclusion: **not as a first-class plugin component**.

The official plugin component list includes `agents`, `skills`, `commands`, `hooks`, `mcpServers`, and `lspServers`; it does not list native `.github/extensions/<name>/extension.mjs` extensions as a plugin component type.

The `copilot-cost` wrapper therefore uses a setup skill to write a generated native-extension shim into the user native-extension discovery path:

```text
~/.copilot/extensions/copilot-cost/extension.mjs
```

That shim imports the bundled plugin extension from the installed plugin cache by absolute file URL. It keeps the native discovery directory small and avoids linking the whole plugin root.

This is a workaround, not an official plugin-native-extension bridge.

## Direct plugin install is valid, but not sufficient

The Copilot CLI plugin reference supports direct subdirectory installs:

```sh
copilot plugin install OWNER/REPO:PATH/TO/PLUGIN
```

That installs the plugin into Copilot's plugin cache. It does not, by itself, make a native `extension.mjs` visible to the native extension loader.

For `copilot-cost`, direct plugin install is a cleaner way to get the setup skill onto the user's machine, but the setup skill is still needed to create the managed shim at `~/.copilot/extensions/copilot-cost/extension.mjs`.
