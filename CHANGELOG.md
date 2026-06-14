# Changelog

## 1.1.0 - Unreleased

- Use Copilot CLI 1.0.62 plugin-shipped native extension support instead of the legacy setup skill and generated user-extension shim.
- Configure the custom footer/statusline from the native extension on startup, preserving prior footer/statusline settings for `/cost` uninstall.
- Migrate existing users by removing the old generated `~/.copilot/extensions/copilot-cost` shim when it has the known managed marker and clearing stale `ext-cost-setup` disabled-skill entries.
- Remove `ext-cost-setup`, setup scripts, shim installer/uninstaller code, and setup-script tests.
- Update install, update, uninstall, development, architecture, and native-extension reference docs for the native plugin extension flow.

## 1.0.1 - 2026-06-14

- Release `copilot-cost` as a marketplace plugin package with aligned plugin, extension, lockfile, and marketplace metadata versions.

## 1.0.0 - 2026-06-14

- Initial `copilot-cost` release.
- Show Copilot CLI message, conversation, session, context, cache, and rolling usage metrics after messages and in the statusline footer.
- Provide `/cost` overview, settings, format customization, diagnostic export, clear-data, and uninstall flows.
