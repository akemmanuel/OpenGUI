# Harness-only session list and transcript page reads

OpenGUI's Backend grew a dual path for session listing (`sync` vs in-memory `SessionService`), hydrated backend rows on every harness list (`ensureSession`), "recovered" sessions without harness proof (`sessionRecordFromWireIdentity`), and Frontend behavior that turned message load failures into empty threads. That contradicts [ADR 0004](./0004-storage-source-of-truth-boundaries.md) and [CONTEXT.md](../../CONTEXT.md): the Harness owns session membership and transcripts; Backend must not answer list or page reads from caches, stubs, or silent error masking.

## Status

superseded by ADR-0010

## Decision

- **Session list read** (sidebar refresh, project hydration): membership comes **only** from the Harness for each `(directory, harnessId)`. If the Harness did not return a session on that read, it must not appear in the API response. Harness list failure for a scope is an error for that scope (batch responses may include per-item `errors[]`).
- **Wire payload for lists** is **Harness session summary** only: normalized fields the Harness reported (ids, title, status, timestamps). No backend-only fields from memory, SSE overlays, or recovered identity. See CONTEXT.md: **Harness session summary**, **Session list read**.
- **Only two HTTP list surfaces** for the product: `GET /api/sessions` (single `directory` + `harnessId`) and `POST /api/sessions/query` (batch fan-out). Query is a **convenience fan-out** (parallel harness list calls), not a second source of truth. **Remove `sync`** from request bodies and query params; do not branch to `SessionService.listSessions` for product reads.
- **Session message page read**: always a Harness fetch with **strict product scope** — `directory`, `harnessId`, and session identity on every request. Pagination follows Harness behavior, normalized to `MessagePageResult`. Load failures propagate as errors; **no** empty success on "session not found". Live transcript while running comes from **Live Session stream**; pages are for history and reconnect gap-fill. See CONTEXT.md: **Session message page read**.
- **Client protocol**: `OpenGuiClient` may expose one friendly list helper, but it must map to **GET or query only** with the same rules—no parallel list dialect (e.g. no `listDirectorySessions` semantics that force `sync: true` or imply a cache).
- **Listing must not call `ensureSession`** (or equivalent index hydration) as part of building the list response. In-memory session state, if retained at all, is for non-list control paths (queue dispatch, SSE side effects) and must not define sidebar membership.

## Considered Options

- **Keep `sync` with cache-fast path**: rejected — two truths; sidebar shows sessions the Harness did not just return.
- **Many parallel GETs from Frontend instead of query**: rejected for now — unnecessary churn; slim query fan-out is enough if it stays harness-only.
- **Delete `POST /api/sessions/query`**: rejected — batch fan-out is fine when it does not add cache semantics.
- **Backend merge SSE into message pages**: rejected — second transcript source; stream + harness pages only.
- **Lenient scope on messages (resolve directory from wire id alone)**: rejected for product calls — routing hints conflict with ADR 0004; queue rows already carry full targets for dispatch.

## Consequences

- Refactor targets: `server/services/session-query.ts`, `session-harness-list.ts`, `session-resolve.ts` (read paths), `server/web-server.ts` session routes, `src/protocol/http-client.ts` (`getMessages`, list helpers), Frontend hooks that assume empty messages or cached lists.
- `resolveSessionRecord` may still exist for **mutations** (queue, delete, prompt) but must not invent sessions for **read** APIs; recovered wire stubs are removed or confined to non-product debug paths.
- Tests that claim list "without writing session index" must match production (no `ensureSession` on list).
- Aligns with Runtime-shaped operations (`directory` + `harnessId` + session id) per [ADR 0005](./0005-opengui-runtime-backend-split-and-sdk.md); implementation plan: [`docs/plans/session-read-slop-removal.md`](../plans/session-read-slop-removal.md).
- Package move (`server/` → `packages/backend`) can proceed in parallel; this ADR applies regardless of file location.

## References

- [ADR 0004](./0004-storage-source-of-truth-boundaries.md) — storage boundaries
- [CONTEXT.md](../../CONTEXT.md) — Harness session summary, Session list read, Session message page read
