---
name: ext-cost-setup
description: Manual-only setup for copilot-cost. Use only when the user explicitly invokes /copilot-cost:ext-cost-setup, invokes the ext-cost-setup skill, or asks to set up the bundled copilot-cost native extension. Never use automatically for configuration, updates, uninstall, cost estimates, billing questions, or unrelated extension work.
user-invocable: true
disable-model-invocation: true
allowed-tools: bash, powershell
---

# ext-cost-setup

Set up the `copilot-cost` plugin's bundled native Copilot CLI extension and statusline command.

This skill has exactly one purpose: first-time setup of the native extension bundled inside the installed plugin. Keep the conversation friendly, transparent, and brief.

## Opening message

Before running commands, explain in plain language:

The skill is single-use. It only helps install a Copilot native extension and connect the footer/statusline command.

Installation is clean and explicit. It only:

1. Writes a managed native-extension shim at `~/.copilot/extensions/copilot-cost/extension.mjs`.
2. Updates `~/.copilot/settings.json` so `statusLine.command` calls the extension code bundled inside the installed plugin and `footer.showCustom` is enabled.
3. Uses Copilot's plugin-data area for `copilot-cost` runtime data and managed-install state.

That's it.

Also say, briefly:

- If another custom statusline command is already configured, setup replaces it with the `copilot-cost` command and saves the previous command for uninstall.
- Later, the user can open `/cost`, choose **Settings**, then choose **Uninstall** to remove the managed files and restore prior statusline/footer settings. They can uninstall the plugin package afterward with `/plugin uninstall copilot-cost`.
- *FYI: Copilot plugins cannot yet install native extensions directly, so this setup creates a managed shim for the bundled extension.*

End the opening with: "I'll now set up the extension for you. You may be prompted to approve the commands."

Do not offer Configure, Update, or Uninstall. Infer the user is installing for the first time.

## Command style

Use the shortest OS-appropriate commands. Show the commands before running them, with a short comment above each command.

On macOS/Linux, use this as the base. The first command finds this installed plugin's root, so it works whether the plugin was installed from a marketplace or directly from a GitHub subdirectory.

```bash
# Find the installed plugin root that contains this setup skill.
PLUGIN_ROOT="$(find "$HOME/.copilot/installed-plugins" -path "*/skills/ext-cost-setup/SKILL.md" -print -quit | sed 's#/skills/ext-cost-setup/SKILL.md$##')"

# Install the managed native-extension shim and statusline command.
node "$PLUGIN_ROOT/scripts/setup.mjs"
```

On Windows PowerShell, use the equivalent shape:

```powershell
# Find the installed plugin root that contains this setup skill.
$SkillFile = Get-ChildItem "$HOME\.copilot\installed-plugins" -Recurse -Filter SKILL.md | Where-Object { $_.FullName -like "*\skills\ext-cost-setup\SKILL.md" } | Select-Object -First 1
$PluginRoot = Split-Path (Split-Path (Split-Path $SkillFile.FullName -Parent) -Parent) -Parent

# Install the managed native-extension shim and statusline command.
node "$PluginRoot\scripts\setup.mjs"
```

The setup script refuses to overwrite unmanaged native-extension files. If it reports an existing unmanaged extension path, stop and explain the conflict rather than trying to force it.

## Optional checks

Only run small checks if needed. Avoid printing a long script. Examples:

```bash
# Confirm the bundled extension exists.
test -f "$PLUGIN_ROOT/extensions/copilot-cost/extension.mjs"

# Show the managed extension shim contents.
sed -n '1,8p' "$HOME/.copilot/extensions/copilot-cost/extension.mjs"
```

## After setup

After the commands run, briefly show what happened as a concise `Activity:` list. Use full paths from setup output when available, and keep each bullet to one line:

Activity:
- `mkdir -p ~/.copilot/extensions/copilot-cost` - ensured the managed extension folder exists.
- `~/.copilot/extensions/copilot-cost/extension.mjs` - installed or verified the lean shim that imports `<PLUGIN_ROOT>/extensions/copilot-cost/extension.mjs`.
- `~/.copilot/settings.json` - configured `statusLine.command` to run `node '<PLUGIN_ROOT>/extensions/copilot-cost/extension.mjs' '--statusline'`, enabled `footer.showCustom`, and enabled `experimental`.
- `~/.copilot/plugin-data/copilot-extensions/copilot-cost/install-state.json` - saved prior statusline/footer settings for uninstall when settings changed; if `COPILOT_PLUGIN_DATA` is set, use `$COPILOT_PLUGIN_DATA/install-state.json` instead.

Do not add a separate explanatory paragraph before or after the `Activity:` list unless setup failed or there is an actionable reload note.

Then refresh Copilot so it discovers the new extension. Prefer the extension reload tool if it is available in the current agent environment. If no direct reload tool is available, tell the user to run `/clear` or start a new Copilot CLI session. If the extension still does not appear, tell the user to run `/extensions`, choose **manage**, and enable `copilot-cost`.

After reload, tell the user the native extension owns `/cost` configuration.

## Avoid this

Do not create symlinks manually. Use the bundled setup script so shim, statusline, and settings behavior stay consistent.
