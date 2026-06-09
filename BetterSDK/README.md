# claude-agent-sdk-lite

Ultraminimal open TypeScript port of the public Python Claude Agent SDK transport shape.

- Uses a local `claude` executable only.
- Does **not** vendor or download Claude Code binaries.
- Supports `query()`, `ClaudeSDKClient`, JSONL stdin/stdout transport, and common CLI flags.

```ts
import { query } from "claude-agent-sdk-lite";

for await (const message of query({
  prompt: "Say hello in one sentence",
  options: { cwd: process.cwd(), permissionMode: "plan" }
})) {
  console.log(message);
}
```

Install Claude Code separately and ensure `claude` is on `PATH`, or pass `options.cliPath`.

This is intentionally tiny. Advanced Python SDK features like MCP SDK servers, hooks, permission callbacks, session stores, and the full control protocol are not implemented yet.

