# Plan: Runtime / Backend split and `@opengui/runtime` SDK

Companion to [ADR 0005](../adr/0005-opengui-runtime-backend-split-and-sdk.md). Domain terms: [`CONTEXT.md`](../../CONTEXT.md).

## Goals

| Goal            | Done when                                                                      |
| --------------- | ------------------------------------------------------------------------------ |
| Clear layers    | Runtime, Backend, Frontend documented and reflected in package boundaries      |
| Lightweight SDK | `pnpm add @opengui/runtime` — in-process harness API, no queue, no React/Hono  |
| Slop removed    | No `projects.*` client, no `/api/projects`, no `workspaceId` on execution APIs |
| App still ships | Desktop/Web work through Backend embedding Runtime                             |

## Non-goals (v1)

- Remote SDK (`connect({ url, token })`)
- Queue in SDK
- Separate repos
- Moving entire Frontend into `packages/frontend` (optional later)

## Target layout

```text
opengui/
├── pnpm-workspace.yaml
├── packages/
│   ├── runtime/          # @opengui/runtime
│   │   ├── src/
│   │   │   ├── host.ts           # createRuntimeHost, in-process invoke
│   │   │   ├── adapters/         # bridges (from *-bridge.ts)
│   │   │   ├── events.ts         # HarnessEvent bus
│   │   │   ├── inventory.ts
│   │   │   └── api/              # public harness(id), sessions, prompt, …
│   │   └── package.json
│   └── backend/          # @opengui/backend
│       ├── src/
│       │   ├── server.ts         # Hono app (from web-server.ts, slimmed)
│       │   ├── queue/            # PromptQueueService + SQLite
│       │   ├── transport/        # HTTP, SSE/WS, optional IPC adapter
│       │   └── facade.ts         # delegates execution to embedded Runtime
│       └── package.json
├── src/                  # Frontend + shared protocol (migrate gradually)
├── server/               # shrink → move into packages/backend
└── packages/runtime/src/adapters/   # harness bridges (done)
```

Shared types (`HarnessEvent`, `HarnessId`, session types) stay importable from a small `packages/runtime` or `packages/protocol` surface; avoid Frontend importing bridge internals.

## Runtime public API (v1 sketch)

Stable integrator surface — names can adjust during extraction:

```ts
import { createOpenGUI } from "@opengui/runtime";

const og = await createOpenGUI({
  dataDir: ".opengui",
  allowedRoots: ["/path/to/repos"],
  harnesses?: HarnessId[], // optional lazy subset
});

const pi = og.harness("pi");
pi.on("event", (e: HarnessEvent) => { … });
await pi.sessions.list({ directory: "/path/to/repos" });
await pi.prompt({ directory, sessionId, text, model?, agent?, variant? });
await pi.abort({ directory, sessionId });
await og.getHarnessInventories();

await og.close();
```

**Contracts**

- Every mutating/listing op includes **`directory`** (and **`harnessId`** via `harness()`).
- **No queue**: if session is running, `prompt` fails with explicit error (e.g. `SESSION_BUSY`); document status check via session list / events.
- **No `workspaceId`** on Runtime types.

## Backend public surface (app)

- Embeds `createRuntimeHost()` from `@opengui/runtime`.
- HTTP routes mirror today’s session/harness/fs/git operations by delegating to Runtime.
- **Keeps** queue routes and SQLite (ADR 0004).
- **Removes** `/api/projects` and workspace-scoped project APIs.
- `OpenGuiClient` trimmed: drop `projects`; drop `harnesses.connectProject` / `disconnectProject`; session/harness methods pass `directory` only.

## Phase 0 — Workspace scaffolding

- [x] Add `pnpm-workspace.yaml` (`packages/*`).
- [x] Create `packages/runtime` and `packages/backend` with `package.json`, `exports`, TypeScript project references.
- [x] Root `package.json` scripts: `vp test` / build still run monorepo-wide.
- [x] Document in this plan only; no user-facing change.

## Phase 1 — Extract Runtime (behavior unchanged)

- [x] Move `server/harness-runtime.ts` into `packages/runtime/src/harness-runtime.ts` (bridges still at repo root; imported via relative paths).
- [x] Implement `createRuntimeHost({ ipcMain, sender, dataDir, broadcast })` wrapping `registerHarnessAdapters`.
- [x] Port `HarnessService`-equivalent orchestration into Runtime (session list, messages, prompt, abort, permissions, questions) calling adapters through host invoke. (`packages/runtime/src/harness-service.ts`; `createHarnessService` + `web-server` invoke.)
- [x] `web-server` calls `createRuntimeHost` from `@opengui/runtime`; `server/harness-runtime.ts` re-exports package.
- [x] `packages/backend` package shell (HTTP still in `server/web-server.ts`).
- [x] Desktop/Electron: verify backend bundle resolves `@opengui/runtime` at build time (`vp build` → `dist-electron/backend.js`; esbuild inlines workspace runtime + bridges; prod sidecar prefers bundled entry over `web-server.ts`).
- [x] Tests: `vp test` green (330).

**Exit criteria:** App runs `pnpm run dev` / `dev:web` with no intentional API changes.

## Phase 2 — Remove backend Project / Workspace slop

- [x] Delete HTTP handlers for `/api/projects` and `/api/projects/*`.
- [x] Remove `ProjectService` CRUD from product path; drop `workspaceId` from `ProjectRecord` usage in API (migrate SQLite if needed: directory-only internal rows for queue only, or inline directory on queue entries only per ADR 0004). _Phase 2b: execution/queue/session scope is directory-first (`directory-scope.ts`); `ProjectService` removed. `StorageService` no longer exposes `projects` CRUD; JSON→SQLite migration copies queue/settings only; legacy `projects` table retained only for old prompt_queue schema migration joins._
- [x] Delete `server/harness-runtime.ts` and `server/services/harness-service.ts` re-export shims; backend imports `HarnessService` from `@opengui/runtime`.
- [x] Update `src/protocol/client.ts`: remove `projects` namespace; remove `connectProject` / `disconnectProject`; strip `workspaceId` from `HarnessTarget` and query types. _`HarnessTarget.workspaceId` retained for Frontend routing/auth; execution bodies use `directory`._
- [x] Update `http-client.ts` and tests.
- [x] Frontend: `use-agent-impl-core` and related hooks — stop calling `connectProject`; list sessions with `directory` from Frontend Project path; map errors to sidebar “unavailable” state.
- [x] Remove `capabilities.server.workspaces` or set false; update capabilities tests.
- [x] `grep workspaceId` in `server/` and protocol — only Frontend-local IDs in UI code, not backend execution. _Server execution uses `directory` only; optional `workspaceId` remains on SQLite queue/project rows and in `HarnessTarget` for Frontend routing/remote workspace auth._

**Exit criteria:** No network traffic to `/api/projects`; Project add/remove is Frontend persistence only.

## Phase 3 — SDK publish and docs

- [x] Export documented API from `@opengui/runtime` (`createOpenGUI`, `harness`, types).
- [x] README section: SDK quickstart (Pi-only example).
- [ ] **Minimal SDK surface (ADR 0007):** [`runtime-sdk-minimal-surface.md`](./runtime-sdk-minimal-surface.md) — `SessionHandle`, `at(directory)`, `onStream`, `diagnose`, `runAgent`.
- [ ] Optional root meta package `opengui` re-exporting runtime for discoverability.
- [x] Update `docs/architecture.md` layer section to match CONTEXT.md (Runtime / Backend / Frontend). _Already aligned; see Runtime layer bullet._

## Phase 4 — Cleanup (follow-up)

Master slop + contributor plan: [`contributor-experience-and-slop-removal.md`](./contributor-experience-and-slop-removal.md).

- [x] Session/transcript read slop (automated): [ADR 0006](../adr/0006-harness-only-session-and-transcript-reads.md), [`session-read-slop-removal.md`](./session-read-slop-removal.md); `pnpm run slop-check` green. Manual: [`session-read-acceptance.md`](../manual/session-read-acceptance.md).
- [ ] Shrink `server/web-server.ts` into `packages/backend` modules.
- [x] Reduce backend session record / routing cache per ADR 0004 (phase B): harness-first list/query; no `replaceScopeSessions` scope purge; ephemeral status cache only.
- [x] Lazy harness adapter loading by `harnesses` option (`createOpenGUI({ harnesses })` → `createRuntimeHost`).
- [ ] `@opengui/client` for remote Backend when needed.

## Risk register

| Risk                                  | Mitigation                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| Electron IPC path breaks              | Keep IPC as Backend transport; Runtime stays process-local inside Backend             |
| Frontend loses early “connect” errors | Standardize error codes from Runtime on list/prompt; Frontend caches per Project path |
| Large PR                              | Phase 1 merge before Phase 2; feature flags only if needed                            |
| SQLite migration                      | Queue already stores harness scope; avoid new project FK                              |

## Verification checklist

- [x] `vp check` / `vp test` green _(automated; re-run after each cleanup tranche)_
- [ ] Manual: add Project path, list sessions, send prompt, stream events (Desktop or Web)
- [ ] Manual: queue still works in UI (Backend)
- [x] Read-only scripts using `@opengui/runtime`: `scripts/runtime/probe-*.mjs` (sessions, resources, messages, inventories; no prompts). `- [ ]` Optional: smallest prompt script documented separately (costs tokens).

## References

- [ADR 0003](../adr/0003-persistent-desktop-backend-transport.md) — Desktop IPC vs HTTP
- [ADR 0004](../adr/0004-storage-source-of-truth-boundaries.md) — Harness vs Backend SQLite
- [ADR 0001](../adr/0001-harness-terminology.md) — Harness naming
