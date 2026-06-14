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

Current conclusion for Copilot CLI 1.0.62 and newer: **yes, plugins can ship native extensions**.

The 1.0.62 changelog says: "Plugins can now ship extensions, making them installable via the plugin marketplace." Installed plugin extensions are discovered from plugin `extensions/<name>/extension.mjs` directories.

Older `copilot-cost` versions used a setup skill to write a generated native-extension shim into the user native-extension discovery path:

```text
~/.copilot/extensions/copilot-cost/extension.mjs
```

That shim imported the bundled plugin extension from the installed plugin cache by absolute file URL. It is now legacy migration state only.

The first-run cleanup removes only shims containing the known generated marker and leaves unmanaged user extensions alone.

## Direct plugin install is sufficient on current CLI

The Copilot CLI plugin reference supports direct subdirectory installs:

```sh
copilot plugin install OWNER/REPO:PATH/TO/PLUGIN
```

On Copilot CLI 1.0.62 and newer, installing the plugin also makes the bundled native extension visible to the native extension loader.
