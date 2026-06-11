# Authoring workflow

This workflow is from the local SDK docs bundled with Copilot CLI 1.0.60.

## Scaffold

Use the extension management tool:

```text
extensions_manage({ operation: "scaffold", name: "my-extension" })
```

For a user-scoped extension:

```text
extensions_manage({ operation: "scaffold", name: "my-extension", location: "user" })
```

## Edit

The generated file must be:

```text
.github/extensions/<name>/extension.mjs
```

or, for user-scoped installs:

```text
~/.copilot/extensions/<name>/extension.mjs
```

Minimal skeleton:

```js
import { joinSession } from "@github/copilot-sdk/extension";

await joinSession({
  tools: [],
  hooks: {},
});
```

## Reload

Use the extension reload tool in an agent session:

```text
extensions_reload({})
```

The local SDK docs describe this as stopping all running extensions, rediscovering/relaunching them, and making new tools available immediately in the same turn.

The htek.dev article lists `/extensions list|enable|disable|reload|info`, but current Copilot CLI behavior observed from the interactive UI is different: `/extensions` opens a menu with **manage** and **mode** options. Use **manage** to toggle discovered extensions and **mode** to choose whether extensions are loaded and whether the agent can manage them. Treat the article's subcommand list as stale unless re-verified against the target CLI.

## Verify

Use:

```text
extensions_manage({ operation: "list" })
extensions_manage({ operation: "inspect", name: "my-extension" })
```

`inspect` is especially useful because it reports extension details and log tails for failed/misbehaving extensions.

## Minimal success criteria

An extension is correctly loaded when:

- It appears in the extension list.
- It is not marked as failed.
- Its registered tools/hooks/commands appear in inspection output where applicable.
- Its log does not show SDK import or JSON-RPC protocol errors.
