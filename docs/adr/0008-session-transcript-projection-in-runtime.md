# Session transcript projection in OpenGUI Runtime

The OpenGUI Frontend reconciles **Live Session stream** events with **Session message page read** results inside `agent-message-state.ts` and `agent-reducer.ts`: per-part merge rules, delta cursors on parts, queued replay while `isLoadingMessages`, session-switch LRU buffers, and idle-time tool finalization. That duplicates execution-layer concerns in presentation code, produces impossible UI states (e.g. an earlier tool row still `running` while later parts on the same assistant message have already rendered), and conflicts with [ADR 0004](./0004-storage-source-of-truth-boundaries.md) and [CONTEXT.md](../../CONTEXT.md): the Frontend may render transcript content but must not own canonical transcript reconciliation.

[ADR 0006](./0006-harness-only-session-and-transcript-reads.md) requires harness-only page reads and a separate live stream; it rejected **durable** backend transcript caches and treating merged SSE+pages as a second source of truth. It did **not** assign **where** OpenGUI fuses stream and pages for connected clients. That fusion currently lives in the Frontend and must move.

## Status

accepted

## Decision

- **Harness** remains the only **durable** source of Session transcripts. **Session message page read** still calls the Harness with strict Harness Scope (`directory`, `harnessId`, session identity). No OpenGUI SQLite or Frontend persistence stores transcript bodies as source of truth ([ADR 0004](./0004-storage-source-of-truth-boundaries.md), [ADR 0006](./0006-harness-only-session-and-transcript-reads.md)).
- **OpenGUI Runtime** owns an in-memory **Session transcript projection** per active Harness Scope (`directory`, `harnessId`, session id). The projection:
  - **Hydrates** from harness message pages (history, pagination, reconnect gap-fill).
  - **Ingests** canonical harness transcript events (`message.*`, `message.part.*`) from adapters before they are published to clients.
  - **Enforces** monotonic transcript invariants (tool `completed` / `error` terminal; no regression from terminal to `running` / `pending`; assistant `time.completed` implies no non-terminal tools on that message; streamed text/reasoning merge is type-specific and must not use text-length rules on tool parts).
  - **Does not** persist to disk or define sidebar session membership.
- **OpenGUI Backend** uses the same Runtime projection for product **Session message page read** responses and **Live Session stream** (SSE/RPC): clients receive **post-projection** snapshots and upserts, not raw harness events that require client-side merge.
- **OpenGUI Frontend** consumes projected transcript snapshots and idempotent message/part upserts. It must **not** implement transcript merge, delta application, tool finalization on idle, or replay queues that re-apply live events against page snapshots. Ephemeral UI buffers (e.g. last viewed snapshot when switching sessions) may cache **server-provided** projection state only; they must not re-run reconciliation ([CONTEXT.md](../../CONTEXT.md) **Session transcript**; ADR 0004 ephemeral buffers).
- **Harness Adapters** map harness-native shapes to normalized events and avoid duplicating projection policy. Adapter-local transcript caches and cross-message merge helpers should converge on the projection module or be reduced to shape mapping only.
- **`@opengui/runtime` SDK** (`SessionHandle.messages()`, stream subscription) reads the same projection so embedders do not reimplement Frontend merge logic ([ADR 0007](./0007-runtime-sdk-minimal-surface.md)).

## Considered Options

- **Keep merge in the Frontend (deeper `transcript-merge` module)**: rejected — wrong layer; multi-tab and SDK consumers would duplicate policy; violates “Frontend does not mutate canonical transcript content” for the merged product view.
- **Persist projection in Backend SQLite**: rejected — second canonical transcript store ([ADR 0004](./0004-storage-source-of-truth-boundaries.md)).
- **Only fix the Frontend text-length merge bug**: rejected — leaves `_pendingSnapshots`, dual active/non-active `PART_UPDATED` paths, buffer rehydrate, and adapter-side merge; same failure class.
- **Emit only harness pages, no live stream**: rejected — contradicts **Live Session stream** ([CONTEXT.md](../../CONTEXT.md), [ADR 0006](./0006-harness-only-session-and-transcript-reads.md)).
- **Frontend applies `PART_DELTA` forever**: rejected — delta cursors and coalescing belong in Runtime projection; Frontend receives full part fields or revisioned snapshots.

## Consequences

- New Runtime module (e.g. `session-transcript-projection`) with unit tests for invariants; wire through `ingestCanonicalEvent` / Backend publish path before SSE.
- Backend message read path: harness page → `projection.hydrate` → return projection slice (not raw harness page + client merge).
- Frontend deletion targets: `normalizeMessageEntries`, `mergeSnapshotPartWithExisting`, `finalizeRunningToolParts*`, `_deltaPositions` merge usage, `_pendingSnapshots` replay merge, divergent `PART_UPDATED` merge branches in `agent-reducer.ts`; slim reducer to snapshot assign + upsert by id.
- Revisit [ADR 0006](./0006-harness-only-session-and-transcript-reads.md) wording “Backend merge SSE into message pages” as **rejected durable second source**; ephemeral Runtime projection for **delivery** is the chosen fusion point, not a harness bypass.
- Implementation plan: [`docs/plans/session-transcript-projection.md`](../plans/session-transcript-projection.md).
- Run `pnpm run slop-check` when touching session paths, `OpenGuiClient` message load, or harness event subscription.

## References

- [ADR 0004](./0004-storage-source-of-truth-boundaries.md) — storage boundaries, ephemeral buffers
- [ADR 0005](./0005-opengui-runtime-backend-split-and-sdk.md) — Runtime vs Backend vs Frontend
- [ADR 0006](./0006-harness-only-session-and-transcript-reads.md) — harness page reads, live stream
- [ADR 0007](./0007-runtime-sdk-minimal-surface.md) — SessionHandle, SDK stream
- [CONTEXT.md](../../CONTEXT.md) — Session transcript, Live Session stream, Session message page read, Tool call
