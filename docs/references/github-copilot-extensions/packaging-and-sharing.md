# Packaging and sharing native Copilot CLI extensions

Native Copilot CLI extension distribution is still less formal than Copilot CLI plugin distribution. This file tracks packaging/deployment patterns seen in docs, examples, and community repos.

## Confirmed discovery target

Regardless of packaging strategy, native extensions must become visible at one of these paths:

```text
.github/extensions/<name>/extension.mjs
~/.copilot/extensions/<name>/extension.mjs
```

The packaging question is therefore: how does the extension code get into one of those locations, and how does it stay updated?

## Observed or plausible patterns

| Pattern | User install shape | Update shape | Strengths | Risks / questions |
| --- | --- | --- | --- | --- |
| Project-scoped checked-in extension | Clone/open repo containing `.github/extensions/<name>/extension.mjs` | Normal repo updates | Simple for repo-specific behavior; no installer | Not user-wide; requires every target repo to include the extension |
| User-scoped manual clone/copy | Clone or copy code into `~/.copilot/extensions/<name>` | `git pull` or manual recopy | Direct native extension install; easy to reason about | Not a good plugin UX; users must manage files manually |
| User-scoped symlink to repo checkout | `ln -s /path/to/repo/ext ~/.copilot/extensions/<name>` | `git pull` in repo checkout | Avoids copying; development-friendly | Requires stable checkout path; symlink behavior on Windows varies |
| Thin wrapper / forwarder `extension.mjs` | Installer writes `~/.copilot/extensions/<name>/extension.mjs` that imports real bundle elsewhere | Wrapper can delegate to updated bundle | Stable native discovery file; can add diagnostics/fingerprints | Requires script/installer; wrapper may embed stale absolute paths |
| Plugin wrapper skill + symlink | Install plugin, then skill links plugin cache into `~/.copilot/extensions/<name>` | `copilot plugin update`; symlink remains | Uses plugin distribution for source delivery; no repo clone | Workaround; plugin cache path varies by install type; symlinking whole plugin root may expose extra files |
| Plugin wrapper skill + generated thin wrapper | Install plugin, then skill writes a tiny `extension.mjs` pointing at plugin cache | `copilot plugin update`; wrapper may need refresh if cache path changes | More precise than symlinking whole plugin root; can validate target | Writes generated code; needs careful transparency and uninstall story |

## Observed community install patterns

### `DamianEdwards/copilot-cli-cost`: plugin plus extension shim plus settings configurator

This is the closest public peer to `copilot-cost`. It uses a three-step install:

1. Install/update a Copilot plugin, primarily through marketplace registration and `copilot plugin install`.
2. Run a shim writer that creates `~/.copilot/extensions/copilot-cli-cost/extension.mjs`.
3. Run a configurator that updates `~/.copilot/settings.json` for extension/statusline support and writes statusline launcher files.

The user-scoped `extension.mjs` is a generated forwarder, not a symlink:

```js
import { pathToFileURL } from "node:url";
await import(pathToFileURL("/absolute/path/to/installed-plugin/.../extension.mjs").href);
```

Important packaging details:

- The installer refuses to overwrite an existing extension file unless it can identify it as managed by that extension.
- It uses `pathToFileURL()` for Windows-compatible absolute imports.
- It backs up `~/.copilot/settings.json` before changing statusline/experimental settings.
- Update is handled with `copilot plugin update`; the shim only needs rewriting if the installed plugin path changes.
- Uninstall is not fully automated in the public docs; users would need to remove the plugin plus the extension shim/statusline files.

For `copilot-cost`, this is the strongest evidence that setup needs to do more than create a native-extension path. The current setup keeps the generated user file to the native-extension shim only, then configures explicit statusline/footer settings that call the installed plugin directly.

### `samcharles93/openagent`: generated wrapper plus managed checkout

OpenAgent installs a real repo checkout under `~/.copilot/openagent/repo`, builds TypeScript to `dist/extension.mjs`, then writes a generated wrapper at:

```text
~/.copilot/extensions/openagent/extension.mjs
```

The wrapper contains a fingerprint and imports the real built bundle. On startup it can detect a stale wrapper and re-run setup before exiting, so the next session uses the refreshed wrapper. This is more complex than a symlink, but it keeps the native discovery directory small and gives the installer a place to add diagnostics, fingerprints, and move/update checks.

Notable build detail: the bundle externalizes `@github/copilot-sdk` / `@github/copilot-sdk/extension` so the CLI-provided SDK resolver remains authoritative at runtime.

OpenAgent also documents a separate `child_process.fork()` gotcha: if an extension needs to fork Node child processes, running the native `copilot` binary may leave `process.execPath` pointing at the Copilot binary rather than Node. Their workaround is a `copilot-oa` wrapper that launches Copilot through Node. This does not currently affect `copilot-cost`, which does not fork child processes, but it matters for future extensions that use worker processes or libraries that call `fork()`.

### Other install shapes seen in real repos

- `htekdev/copilot-self-restart`: documents manual copy into either `.github/extensions/self-restart/` or `~/.copilot/extensions/self-restart/`; no plugin, no installer, no build step.
- `microsoft/copilot-brag-sheet`: recommends shell/PowerShell installers that clone or copy directly into `~/.copilot/extensions/copilot-brag-sheet/`; also supports an npm global installer. Its `plugin.json` is metadata, not the primary install path.
- `shsolomo/myelin`: supports npm/global setup and project-level package installs, bundles TypeScript with esbuild into a single native `extension.mjs`.

## Current `copilot-cost` pattern

Current setup:

1. Install the plugin.
2. Run `/copilot-cost:ext-cost-setup`.
3. Skill finds the installed plugin root.
4. Skill runs the bundled setup scripts, which create one generated native-extension shim:

```text
~/.copilot/extensions/copilot-cost/extension.mjs
```

The generated native shim imports the bundled plugin extension by absolute file URL. Setup also updates `~/.copilot/settings.json` with `statusLine.command`, `footer.showCustom`, and `experimental`. The statusline command points at the installed plugin's bundled extension directly with `node`. If the user already has a statusline command, setup replaces it and stores the original managed-install baseline for uninstall restoration rather than trying to combine arbitrary shell commands. Because official config docs describe `statusLine.command` as an ordinary command that receives JSON on stdin, setup requires Node.js 18+ to be installed as `node` instead of trying to find alternate Node executables. This avoids creating a product-specific `~/.copilot/copilot-cost` folder.

Questions to investigate:

- Does `copilot plugin update` preserve the same plugin cache path for direct installs and marketplace installs?
- Does reload discover a newly created user extension directory, or is a full CLI restart needed for first install?
- Should the native shim also self-repair if its embedded plugin path becomes stale after update?

## What to look for in real-world repos

For each example extension, capture:

- Install command(s)
- Whether it uses project-scoped or user-scoped discovery
- Whether it copies, symlinks, writes a wrapper, or asks users to clone
- Build/bundle strategy
- How updates work
- How uninstall works
- Windows support
- Whether it also ships a `plugin.json`
- Whether the author frames the approach as official, experimental, or a workaround

## Risks identified for `copilot-cost`

These were identified during a packaging-focused review and need empirical verification:

1. **Plugin update may break discovery indirection.** The native shim embeds an installed plugin path; rerun setup after plugin updates if discovery fails.
2. **First-time refresh behavior needs verification.** `/clear`, starting a new session, full restart, and the agent environment's internal reload tool may not be equivalent for newly added user extensions across CLI versions. Current user-facing `/extensions` opens **manage** and **mode** menus, not a documented reload subcommand.
3. **Node child-process behavior may differ under the native Copilot binary.** Extensions that call `child_process.fork()` may need extra testing because `process.execPath` can point at the Copilot binary rather than Node.
