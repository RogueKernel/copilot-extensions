# Architecture and discovery

Native Copilot CLI extensions run as separate Node.js child processes. The CLI discovers extension folders, forks each `extension.mjs`, and communicates with it over JSON-RPC on stdio.

## Process model

The extension process:

1. Imports `joinSession` from `@github/copilot-sdk/extension`.
2. Calls `joinSession({ ... })`.
3. Registers tools, hooks, commands, agents, MCP servers, or event listeners.
4. Uses the returned `session` object for logging, events, messaging, and RPC.

The CLI parent process:

1. Discovers extension directories.
2. Launches extension child processes.
3. Resolves `@github/copilot-sdk` automatically.
4. Routes tool calls, hooks, events, and session APIs over JSON-RPC.
5. Stops/restarts extensions on lifecycle transitions.

## Discovery paths

Verified in the bundled SDK docs for Copilot CLI 1.0.60:

- Project-scoped extensions: `.github/extensions/<name>/extension.mjs`
- User-scoped extensions: `~/.copilot/extensions/<name>/extension.mjs`

Discovery rules:

- Only immediate subdirectories are checked.
- The entrypoint must be named exactly `extension.mjs`.
- Only ES modules are supported (`.mjs`, `import`/`export`).
- The SDK resolver is provided by the CLI; do not install `@github/copilot-sdk` into the extension folder.
- Project extensions shadow user extensions with the same name.

## Lifecycle

Documented behavior in the local SDK docs:

- Extensions are forked as child processes.
- `/clear`, foreground-session replacement, or explicit reload stops and re-discovers extensions.
- CLI exit terminates extension processes with SIGTERM, then SIGKILL after a grace period.
- In-memory extension state is not durable across reload; persist important data to disk.

## Experimental mode

The Copilot CLI 1.0.60 verification pass did **not** find a native-extension-specific config key. `copilot help config` exposed a general `experimental` setting:

```text
experimental: whether to enable experimental features; defaults to false.
Can be enabled with --experimental flag, /settings experimental on, or /experimental (deprecated)
```

However, native extensions were active in this repository under Copilot CLI 1.0.60. The htek.dev article did not appear in the fetched text to require experimental mode. If a user cannot see extension behavior, check:

1. Copilot CLI version.
2. Whether extensions are disabled in local settings.
3. Whether the extension appears in `/env` or extension management output.
4. Extension log output.

An external official-docs verification pass found no official documentation saying native extensions require experimental mode. Official docs do describe a general experimental mode for unreleased features, but the visible documented example was not native extensions.

## Why stdout matters

The extension protocol uses stdout for JSON-RPC. Do not write user/debug output with `console.log()`. Use:

- `session.log()` for user-visible timeline messages.
- `console.error()` or a file logger for debugging.

Writing ordinary text to stdout can corrupt the protocol and crash the extension.
