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

const sessions = await pi.sessions.list();
const session =
  sessions[0] != null ? await pi.sessions.open(sessions[0].id) : await pi.sessions.create();

const liveTypes: string[] = [];
const offLive = session.onEvent((event) => {
  liveTypes.push(event.type);
});

await session.send("List the top-level files in this repo in one sentence.");
await session.waitUntilIdle({ timeoutMs: 90_000 });

offLive();

// SDK does not queue: if the session is busy, send throws SESSION_BUSY unless whileBusy: "wait"
await session.abort().catch(() => undefined);

await og.close();
```

## Tests

SDK unit tests: `src/__tests__/`. Bridge mapping: `src/adapters/__tests__/`.

```bash
pnpm run test:runtime
```

Harness adapters keep pure mapping in `src/adapters/*-bridge-mapping.ts`. Bridge-only:

```bash
pnpm run test:bridges
```

See [`docs/plans/bridge-test-matrix.md`](../../docs/plans/bridge-test-matrix.md).

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

| Export                                          | Role                                          |
| ----------------------------------------------- | --------------------------------------------- |
| `createOpenGUI(options)`                        | Boot in-process runtime                       |
| `og.at(path).harness(id)`                       | Preferred: directory-scoped harness handle    |
| `og.harness(id)`                                | Unbound handle; pass `directory` on each call |
| `og.registerDirectory` / `releaseDirectory`     | Multi-harness directory registration          |
| `og.getHarnessInventories()`                    | CLI readiness                                 |
| `og.diagnose()`                                 | Compact readiness snapshot                    |
| `runAgent(og, { directory, harness, message })` | One-shot send + wait (scripts)                |
| `createOpenGUI({ harnesses: ["pi"] })`          | Lazy adapter load (cold start)                |
| `og.close()`                                    | Tear down sender                              |
| `OpenGuiSdkError`                               | `SESSION_BUSY`, `HARNESS_MISMATCH`, …         |

### Live session events (`LiveSessionEvent`)

Subscribe per session with `session.onEvent(handler)`. This is the stable live stream contract for SDK users. Harness-native bridge events are normalized inside Runtime; normal SDK consumers should not subscribe to `harness.on("event")` except for explicit diagnostics.

`session.onStream(handler)` remains as a legacy ergonomic helper and is derived from `LiveSessionEvent`.

**Diagnostics:** `harness.on("event", …)` still receives raw harness bridge events for debugging adapters. Do not build product logic on `message.part.delta` / `session.status` at this layer.

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

`InProcessIpcMain` / `InProcessIpcSender` and `resolveSafeDirectory` are wired in `@opengui/backend` (`createBackendHost`); `server/web-server.ts` only starts the HTTP server.
