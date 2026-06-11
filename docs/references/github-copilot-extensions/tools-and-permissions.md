# Tools and permissions

Native extensions can register custom tools that the agent can call like built-in tools.

## Tool definition

Tool definitions include:

- `name` — globally unique tool name.
- `description` — shown to the agent.
- `parameters` — optional JSON Schema for arguments.
- `handler(args, invocation)` — async function that returns the tool result.

Skeleton:

```js
{
  name: "myext_do_thing",
  description: "Does one useful thing.",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "Input value" },
    },
    required: ["input"],
  },
  handler: async (args, invocation) => {
    return `Processed ${args.input}`;
  },
}
```

## Invocation metadata

The second handler argument includes:

- `sessionId`
- `toolCallId`
- `toolName`

Use this for tracing, logging, and correlating start/complete events.

## Return values

Handlers can return:

- A string, treated as a successful text result.
- A structured object such as `{ textResultForLlm, resultType }`.

Known result types from the local SDK docs:

- `success`
- `failure`
- `rejected`
- `denied`
- `timeout`

## Tool name collisions

Tool names must be globally unique across loaded extensions. The local SDK docs say collisions cause the second extension to fail to initialize.

Practical convention: prefix tools with the extension name, for example `copilot_cost_status` rather than `status`.

## Permissions

The article describes `onPermissionRequest` and trusted/read-only tool patterns. The local SDK docs confirm permission-related hooks and events, especially:

- `onPreToolUse`, which can return `permissionDecision`.
- `permission.requested` events, which expose permission prompts.
- `onPermissionRequest` in `JoinSessionConfig`, verified in `extension.d.ts`.
- `skipPermission` on tool definitions, verified in `types.d.ts`.

Use conservative defaults for production extensions:

- Avoid `approveAll` except in throwaway development examples.
- Prompt for writes/shell execution unless the action is clearly safe.
- Never hide permission-impacting behavior behind broad helper scripts.

## stdout and logging

Do not use `console.log()` for debugging or user output. stdout is reserved for JSON-RPC. Prefer:

- `session.log("message")` for CLI timeline output.
- `console.error("debug")` for stderr diagnostics.
