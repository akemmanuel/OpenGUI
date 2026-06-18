# @opengui/runtime

In-process **OpenGUI Runtime**: harness adapters, normalized events, and agent sends. This is the v1 SDK surface for integrators who want directory-scoped sessions without HTTP or the React UI.

See [`docs/plans/runtime-backend-sdk-split.md`](../../docs/plans/runtime-backend-sdk-split.md), [ADR 0005](../../docs/adr/0005-opengui-runtime-backend-split-and-sdk.md), and [ADR 0007](../../docs/adr/0007-runtime-sdk-minimal-surface.md) (minimal SDK).

## Install (monorepo)

The package is `private: true` in this repo. Depend on it from workspace packages or app code:

```json
"@opengui/runtime": "workspace:*"
```

## Quickstart (Pi harness)

Requires the `pi` CLI on `PATH` and a git directory under `allowedRoots`.

```ts
import { createOpenGUI } from "@opengui/runtime";

const repo = "/path/to/your/repo";

const og = await createOpenGUI({
  dataDir: ".opengui-runtime",
  allowedRoots: [repo],
});

const dir = await og.at(repo);
await dir.connect({ harnesses: ["pi"] });
const pi = dir.harness("pi");

// Legacy: `og.harness("pi")` still works; pass `directory` on each call.

const unsubscribe = pi.on("event", (event) => {
  console.log("[pi]", event.type, event);
});

const sessions = await pi.sessions.list();
const session =
  sessions[0] != null ? await pi.sessions.open(sessions[0].id) : await pi.sessions.create();

await session.send("List the top-level files in this repo in one sentence.");

// Legacy: pi.prompt({ directory: repo, sessionId, text }) still works.

const streamTypes: string[] = [];
const offStream = session.onStream((event) => {
  streamTypes.push(event.type);
});

await session.send("List the top-level files in this repo in one sentence.");
await session.waitUntilIdle({ timeoutMs: 90_000 });

offStream();

// SDK does not queue: if the session is busy, send throws SESSION_BUSY unless whileBusy: "wait"
await session.abort().catch(() => undefined);

unsubscribe();
await og.close();
```

### Session IDs

- **List** returns harness session objects; `id` is often `pi:<rawId>` (see `parseFrontendSessionId` in the app).
- **prompt** / **abort** accept either the listed `id` or the raw harness id.

### Inventories and diagnose

```ts
const inventories = og.getHarnessInventories();
const { ok, harnesses } = og.diagnose();
```

`diagnose()` is a small snapshot (`cliOnPath`, `ready`, `hint`) from inventories (CONTEXT **Harness Inventory**).

### Script one-liner (`runAgent`)

```ts
import { createOpenGUI, runAgent } from "@opengui/runtime";

const og = await createOpenGUI({ allowedRoots: [repo], harnesses: ["pi"] });
try {
  const result = await runAgent(og, {
    directory: repo,
    harness: "pi",
    message: "List top-level files in one sentence.",
  });
  console.log(result.assistantText, result.reason);
} finally {
  await og.close();
}
```

CLI: `pnpm vp node scripts/runtime/run-agent.mjs -d . -H pi "your prompt"` (uses tokens).

## Public API

| Export                                          | Role                                     |
| ----------------------------------------------- | ---------------------------------------- |
| `createOpenGUI(options)`                        | Boot in-process runtime                  |
| `og.harness(id)`                                | Per-harness handle (`pi`, `opencode`, …) |
| `og.registerDirectory` / `releaseDirectory`     | Multi-harness directory registration     |
| `og.getHarnessInventories()`                    | CLI readiness                            |
| `og.diagnose()`                                 | Compact readiness snapshot               |
| `runAgent(og, { directory, harness, message })` | One-shot send + wait (scripts)           |
| `createOpenGUI({ harnesses: ["pi"] })`          | Lazy adapter load (cold start)           |
| `og.close()`                                    | Tear down sender                         |
| `OpenGuiSdkError`                               | `SESSION_BUSY`, `HARNESS_MISMATCH`, …    |

### Agent streaming (`AgentStreamEvent`)

Subscribe per session with `session.onStream(handler)`. Events are mapped from internal harness bridges—not full `HarnessEvent`.

| Harness       | `text.delta` / `thinking.delta`             | `tool.*`                      | `run.start` / `run.end` |
| ------------- | ------------------------------------------- | ----------------------------- | ----------------------- |
| `codex`       | `message.part.delta`                        | `message.part.updated` (tool) | `session.status`        |
| `claude-code` | `message.part.delta`                        | `message.part.updated`        | `session.status`        |
| `pi`          | Often via full part updates only (no delta) | `message.part.updated`        | `session.status`        |
| `opencode`    | Harness-dependent                           | Harness-dependent             | `session.status`        |

For Pi extensions, tree navigation, or Pi RPC mode, use **`@earendil-works/pi-coding-agent`** directly (ADR 0007).

## Contracts (v1)

- Every operation is scoped by **`directory`** (canonical path under `allowedRoots`).
- **No prompt queue** in the SDK — use the Backend HTTP API for queued prompts.
- Runtime types do not use **`workspaceId`** (Frontend-only).

## Read-only probe scripts

From the monorepo root (no prompts):

```bash
pnpm run runtime:probe:inventories
pnpm run runtime:probe:all -- -d /path/to/repo
```

See [`scripts/runtime/README.md`](../../scripts/runtime/README.md).

### Harness handle (read-only)

| Method                                       | Role                            |
| -------------------------------------------- | ------------------------------- |
| `sessions.list({ directory })`               | List sessions                   |
| `loadResources({ directory })`               | Providers, agents, commands     |
| `messages({ directory, sessionId, limit? })` | Transcript read                 |
| `directoryStatus({ directory })`             | Connection + session status map |

## Backend reuse

`InProcessIpcMain` / `InProcessIpcSender` and `resolveSafeDirectory` are shared with `server/web-server.ts`.
