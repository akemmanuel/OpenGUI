# Split OpenGUI into Runtime, Backend, and Frontend; SDK on Runtime

OpenGUI grew as one Node server (`web-server.ts`) that simultaneously hosted Harness bridges, HTTP APIs, SQLite queues, and legacy “backend Workspace / Project” CRUD. That made every architecture discussion ambiguous (the old “Backend = server and agent runtime” collision) and blocked a lightweight programmatic SDK. We are separating an in-process **OpenGUI Runtime** (Harness execution) from a networked **OpenGUI Backend** (multi-Frontend shared concerns), publishing **`@opengui/runtime`** as the v1 SDK, and removing backend Project CRUD in favor of **Harness Scope on every operation** with lazy directory setup.

## Status

accepted

## Decision

- Introduce **OpenGUI Runtime** as the in-process engine: Harness Adapters (bridges), normalized `HarnessEvent` stream, Harness Inventory, and Agent sends scoped by **`harnessId` + directory + harness session id**. Session and transcript truth remain in the Harness only.
- **OpenGUI Backend** embeds exactly one Runtime per process and adds only multi-client product concerns: HTTP/WebSocket/SSE (and Desktop private IPC transport per ADR 0003), **Queued prompts** and Queue dispatch, Backend arbitration, backend access token auth, and Backend persistence for queue rows and uploaded-prompt cleanup records. It does not own Workspace identity or sidebar Project membership.
- **OpenGUI Frontend** (unchanged role) owns Workspaces, Frontend Projects (saved paths), Pending prompts, queue UI, and presentation metadata; it talks to Backend via `OpenGuiClient`.
- **SDK v1** is **`@opengui/runtime`**: in-process only. No remote `connect()` requirement, **no queue API** (callers buffer or wait for idle). Remote Backend client is a later package.
- **No public connect/attach API**: Runtime does not expose `connectProject`, `attachDirectory`, or backend Project CRUD. Each listing or Agent send carries `directory`; Harness access is established on first use subject to allowed roots and Harness readiness. Frontend “Project connection” is presentation plus errors surfaced from those operations.
- **Remove backend Workspace / Project slop**: deprecate and delete `OpenGuiClient.projects`, `/api/projects*`, `workspaceId` on execution targets, and `capabilities.server.workspaces`. **Backend Project records** in SQLite are legacy and must not drive navigation; queue rows may still store directory + harness scope explicitly (ADR 0004).
- **Monorepo layout**: pnpm workspaces with **`packages/runtime`** (`@opengui/runtime`) and **`packages/backend`** (`@opengui/backend`); Frontend and Shells remain in-repo until optionally moved under `apps/` or `packages/frontend`.

## Considered Options

- **SDK spawns full HTTP Backend (`launch()` → `web-server`)**: rejected for v1 — heavy install, loopback auth, and duplicates Runtime behind HTTP without adding SDK needs (no queue).
- **SDK as thin HTTP client only**: rejected for v1 — “out of the box” goal and lightweight cold start favor in-process Runtime.
- **Keep `connectProject` / backend Project CRUD**: rejected — conflicts with CONTEXT.md (invalid Backend Workspace; Project is Frontend-owned path). Replaced by lazy directory on each op.
- **SDK includes queue parity**: rejected — queue is Backend shared-session machinery; integrators implement their own buffering.
- **In-repo folders without workspaces**: rejected — unclear publish boundaries and entangled imports for SDK consumers.

## Consequences

- `CONTEXT.md` architecture and glossary define Runtime vs Backend; contributors read ADR 0005 when wondering why `/api/projects` disappeared.
- Extraction order: **Runtime package first** with Backend delegating to it while legacy HTTP routes may remain briefly; then delete Project CRUD and `connectProject` usage in Frontend; then document and publish SDK exports.
- `HarnessService` / bridge registration move under Runtime with an in-process invoke registry; Electron IPC and HTTP become transports into Backend, not into bridges directly from UI.
- Frontend must stop relying on `harnesses.connectProject` for readiness; session list and send errors become the source of “project unavailable” UX.
- Queue and multi-Frontend behavior stay on Backend only; Desktop persistent backend process is a Backend deployment that embeds Runtime, not a separate harness host.
- Follow-up work (not blocking ADR): reduce backend session SQLite/routing caches per ADR 0004; optional `@opengui/client` for remote Backend later.
