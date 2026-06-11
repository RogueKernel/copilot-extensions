# Session UI and control APIs

After `joinSession()`, the returned `session` object is the extension's live handle into the current Copilot CLI session.

In this extension-host context, a Copilot CLI `session` means the running Copilot instance in a terminal. It starts when `copilot` is opened and ends when that terminal instance exits. Do not treat a host session as a durable user conversation or as an account-level accounting boundary.

## Logging

Use `session.log()` for timeline output:

```js
await session.log("Extension ready");
await session.log("Something needs attention", { level: "warning" });
await session.log("Transient progress", { ephemeral: true });
```

## Sending messages

Extensions can send follow-up messages:

```js
await session.send({ prompt: "Run the tests and report failures." });
```

They can also send and wait for the session to become idle:

```js
const response = await session.sendAndWait({ prompt: "Summarize the last change." });
```

Do not call `session.send()` synchronously from `onUserPromptSubmitted`; schedule it asynchronously to avoid recursive prompt loops.

## Structured UI

The article describes structured elicitation through `session.ui.elicitation()` and convenience helpers such as confirm/select/input when the host supports them. These APIs are present in the local SDK types for Copilot CLI 1.0.60.

Supported by `session.d.ts` and `types.d.ts`:

- `session.capabilities.ui?.elicitation`
- `session.ui.elicitation(params)`
- `session.ui.confirm(message)`
- `session.ui.select(message, options)`
- `session.ui.input(message, options?)`

Treat UI APIs as capability-gated: check `session.capabilities.ui?.elicitation` before calling them.

## Workspace path

The local SDK docs expose:

```js
session.workspacePath
```

This points at the session workspace directory when available, for example the directory containing `plan.md`, checkpoints, and session artifacts.

The workspace path is useful for runtime artifacts. It is not evidence that all cost or usage under that path belongs to a stable conversation. Cost/accounting features should prefer explicit account/activity sources for historical totals. For active runtime accounting, session-scoped official counters can reconcile locally observed assistant and compaction usage because those local events can undercount, but the host session itself is still not a durable conversation or account boundary.

## Advanced control APIs

The article describes advanced APIs that are present in the local SDK types for Copilot CLI 1.0.60:

- `session.setModel(model, options?)`
- `session.abort()`
- `session.getEvents()`
- `session.disconnect()`
- `commands?: CommandDefinition[]`
- `systemMessage?: SystemMessageConfig`
- `mcpServers?: Record<string, MCPServerConfig>`
- `customAgents?: CustomAgentConfig[]`
- `infiniteSessions?: InfiniteSessionConfig`
- `provider?: ProviderConfig`

The type presence means these APIs are available to compile against in the bundled SDK. Runtime behavior can still be host/version dependent, especially for UI and command surfaces.
