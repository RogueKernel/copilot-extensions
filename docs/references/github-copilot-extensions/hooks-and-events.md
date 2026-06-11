# Hooks and events

Hooks are for controlling or modifying behavior. Events are for observing what happened.

## Hooks

There are two related hook systems:

- **SDK hooks** registered inside a native extension with `joinSession({ hooks: ... })`.
- **Shell hooks** configured through JSON files or plugin `hooks.json`; these run external commands, HTTP calls, or prompt hooks.

Keep them separate when reasoning about packaging. Plugin `hooks.json` files can be distributed as first-class plugin components; native SDK hooks still require a native `extension.mjs` to be discovered.

The local SDK docs list six lifecycle hooks:

| Hook | Fires when | Can do |
| --- | --- | --- |
| `onSessionStart` | Session starts, resumes, or is replaced | Add initial context |
| `onUserPromptSubmitted` | User submits a prompt | Modify prompt or add hidden context |
| `onPreToolUse` | Before a tool executes | Allow/deny/ask, modify args, add context |
| `onPostToolUse` | After a tool executes | Modify result or add context |
| `onErrorOccurred` | Model/tool/system/user-input error occurs | Retry, skip, abort, notify |
| `onSessionEnd` | Session ends | Summarize or describe cleanup |

All hook inputs include `timestamp` and `cwd`. Hook handlers receive an `invocation` object with at least `sessionId`.

## Events

Use `session.on()` after `joinSession()`:

```js
const unsubscribe = session.on("tool.execution_complete", (event) => {
  // event.type and event.data are available
});
```

The local SDK docs list key event types:

| Event | Useful fields |
| --- | --- |
| `assistant.message` | `content`, `messageId`, `toolRequests` |
| `assistant.streaming_delta` | `totalResponseSizeBytes` |
| `assistant.turn_start` | `turnId` |
| `tool.execution_start` | `toolCallId`, `toolName`, `arguments` |
| `tool.execution_complete` | `toolCallId`, `toolName`, `success`, `result`, `error` |
| `user.message` | `content`, `attachments`, `source` |
| `session.idle` | `backgroundTasks` |
| `session.error` | `errorType`, `message`, `stack` |
| `session.shutdown` | `shutdownType`, `totalPremiumRequests`, `codeChanges` |
| `permission.requested` | `requestId`, `permissionRequest.kind` |

## Wildcard listeners

The article and local examples describe listening to all events with:

```js
session.on((event) => {
  console.error(`[${event.type}]`);
});
```

Use this for debugging and audit logs, but avoid logging sensitive content by default.

## Known hook risk

The article claims a hook overwrite bug: if multiple extensions register hooks, only the last-loaded extension's hooks fire. This claim is not present in the local SDK docs. It references `github/copilot-cli#2076`, which may not be publicly accessible or may be version-specific.

Until verified in the target CLI version, a safe architecture is:

- Put behavior-changing hooks in one extension.
- Use `session.on()` event listeners for observational extensions.
- Avoid depending on extension load order.

## Shell hooks

Official Copilot CLI hook docs describe a separate shell-hook mechanism. These hooks are discovered from policy, repository, user, inline settings, and plugin-provided `hooks.json` files. Supported hook entry types include `command`, `http`, and `prompt`.

Shell hooks are useful for plugin-only integrations because they do not require a native SDK extension. They are synchronous, so keep them short; the official guidance is to keep hook execution under about five seconds. Security behavior differs by entry type: command `preToolUse` hooks fail closed on errors, while HTTP `preToolUse` hooks fail open to the default permission flow on network errors.
