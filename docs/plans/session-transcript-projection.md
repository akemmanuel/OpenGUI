# Plan: cut off transcript slop

Companion to [ADR 0008](../adr/0008-session-transcript-projection-in-runtime.md). Domain terms: [CONTEXT.md](../../CONTEXT.md).

## Intent

Stop moving transcript reconciliation around. Cut it down to one Runtime module and delete everything else.

**First cut landed:** Runtime now exposes `session-transcripts.ts`; Backend uses explicit `services.transcripts`; SDK message reads use `transcripts.readPage`; `server/transcript-projection.ts` and `SessionTranscriptProjectionRegistry` are deleted; `slop-check` blocks those prototype seams from returning.

The current first pass is still too cluttered:

- Backend singleton: `server/transcript-projection.ts`
- hidden dynamic import from `server/services/session-lifecycle-actions.ts`
- shallow `SessionTranscriptProjectionRegistry`
- projection keys that omit `directory`
- `SessionHandle.messages()` bypassing projection
- Frontend `mergeMessageSnapshot`, `PART_DELTA`, `_pendingSnapshots`
- adapter transcript caches with unclear ownership

This plan removes those seams instead of deepening them.

## Hard rules

1. **One owner:** Runtime owns transcript projection. Backend and SDK call it; they do not create their own projection state.
2. **One key:** projection key is exactly `{ directory, harnessId, sessionId }`. No fallback key, no `directory: ""`.
3. **One output level:** projected output is **message-level**, not part-level. Frontend replaces/upserts whole `MessageEntry` objects.
4. **No Frontend deltas:** raw `message.part.delta` never reaches product transcript state.
5. **No Frontend reconciliation:** no merge, replay, tool-finalize, delta cursor, or page/live fusion in `src/hooks`.
6. **No hidden dependency:** no dynamic import of transcript state from Backend service code.
7. **Fail closed:** if Backend cannot resolve Harness Scope for a transcript event, it logs and drops that event. The next message page read repairs from Harness history. Do not emit unscoped raw transcript events to the Frontend.

## Minimal target shape

Add exactly one public Runtime module:

`packages/runtime/src/session-transcripts.ts`

```ts
export interface SessionTranscripts {
  ingest(input: { scope: SessionTranscriptScope; event: HarnessEvent }): ProjectedTranscriptEvent[];

  readPage(input: {
    scope: SessionTranscriptScope;
    options?: { limit?: number; before?: string | null };
    fetchHarnessPage: () => Promise<MessagePageResult>;
  }): Promise<ProjectedMessagePage>;

  snapshot(scope: SessionTranscriptScope): ProjectedTranscriptSnapshot | null;
  evict(scope: SessionTranscriptScope): void;
}
```

Only three projected event types:

```ts
type ProjectedTranscriptEvent =
  | {
      type: "transcript.snapshot";
      scope: SessionTranscriptScope;
      revision: number;
      page: ProjectedMessagePage;
    }
  | {
      type: "transcript.message";
      scope: SessionTranscriptScope;
      revision: number;
      entry: MessageEntry;
    }
  | {
      type: "transcript.message.removed";
      scope: SessionTranscriptScope;
      revision: number;
      messageID: string;
    };
```

No `transcript.part.*`. No `message.part.delta` outside Runtime. If one part changes, Runtime emits the whole projected message entry.

Implementation may have private helpers/classes in that file, but callers only see `SessionTranscripts`.

## Scope resolution: no new index

Do **not** add a separate `SessionScopeIndex`.

Use existing scope sources:

- **Backend message read:** route already has `scopeRef` and `SessionRecord`.
- **Backend SSE:** resolve `sessionId` through `services.sessions.getSession(sessionId, { harnessId })` and use the returned `directory` / `harnessId` / `id`.
- **SDK `SessionHandle`:** handle closure already has `directory`, `harnessId`, and `sessionId`.
- **Harness adapter page reads:** caller supplies the scope.

If `getSession` cannot resolve a transcript event, drop it with a rate-limited diagnostic. Do not invent scope.

## Cut plan

### Step 0 — add failing slop guard

Add `scripts/transcript-slop-check.mjs` and call it from `pnpm run slop-check`.

It must fail on:

```txt
server/transcript-projection.ts
new SessionTranscriptProjectionRegistry
serverTranscriptProjections
dynamic import("*transcript-projection*")
directory: ""
mergeMessageSnapshot in src/hooks
PART_DELTA in src/hooks
_pendingSnapshots in src/hooks
_deltaPositions in src/hooks
finalizeRunningToolParts in src/hooks
normalizeMessageEntries in src/hooks
mergeSnapshotPartWithExisting in src/hooks
```

Commit this early so cleanup cannot regress.

### Step 1 — replace prototype projection with one Runtime module

Delete / stop exporting:

- `packages/runtime/src/session-transcript-projection-registry.ts`
- `server/transcript-projection.ts`

Move projection behavior into:

- `packages/runtime/src/session-transcripts.ts`

Keep the engine tiny:

- map by full `SessionTranscriptScope`
- hydrate page into message entries
- ingest raw transcript event into one message entry
- emit message-level projected event
- maintain `revision`
- terminal tool monotonicity
- completed message finalizes tools
- apply deltas privately

No registry class. No coordinator class. No scope index.

### Step 2 — wire Backend explicitly

Add `transcripts` to `BackendServiceContext` when the web server starts:

```ts
const transcripts = createSessionTranscripts();
servicesStub.transcripts = transcripts;
```

Change message reads:

```ts
services.transcripts.readPage({
  scope: { directory: session.directory, harnessId: session.harnessId, sessionId: session.id },
  options,
  fetchHarnessPage: () => services.harnesses.listMessages(...),
})
```

Change SSE publish:

1. normalize Harness event;
2. if not transcript, publish as today;
3. if transcript, resolve `SessionRecord` from `services.sessions`;
4. if no scope, log/drop;
5. call `services.transcripts.ingest({ scope, event })`;
6. publish projected `transcript.*` events only.

Delete dynamic imports.

### Step 3 — wire SDK through the same interface

`createSessionHandle` gets a `transcripts` dependency.

`SessionHandle.messages()` becomes:

```ts
transcripts.readPage({ scope, options, fetchHarnessPage });
```

`SessionHandle.onStream()` receives projected transcript events or maps projected message events into SDK stream events.

No direct SDK transcript read through `HarnessService.listMessages()`.

### Step 4 — switch Frontend to message-level projected transcript actions

Add three actions:

```ts
TRANSCRIPT_SNAPSHOT;
TRANSCRIPT_MESSAGE;
TRANSCRIPT_MESSAGE_REMOVED;
```

Frontend reducer rules:

- `TRANSCRIPT_SNAPSHOT`: replace messages for the active session if revision is newer.
- `TRANSCRIPT_MESSAGE`: replace or append one whole `MessageEntry` by `info.id`.
- `TRANSCRIPT_MESSAGE_REMOVED`: remove by id.

Delete from `src/hooks`:

- `mergeMessageSnapshot`
- `applyStreamingDeltaToPart`
- `createPlaceholderPart`
- `PART_DELTA`
- `_pendingSnapshots`
- local tool finalization
- any page/live replay logic

Session buffers may remain, but only as `{ revision, messages, hasMore, cursor }` snapshots delivered by Backend. They do not merge.

### Step 5 — strip adapter policy

Audit adapters after Runtime projection is authoritative.

Allowed adapter state:

- IDs needed to translate native events into OpenGUI `HarnessEvent`
- in-flight native transport buffers needed to emit a syntactically complete event

Forbidden adapter state:

- cross-page transcript caches
- terminal-status reconciliation
- page/live merge
- “transcript cache” naming for projection-like behavior

Rename unavoidable transport state to transport terms.

### Step 6 — delete compatibility names

Once Frontend consumes `transcript.*`:

- stop dispatching `MESSAGE_UPDATED`, `PART_UPDATED`, `PART_DELTA` for product transcript state;
- keep old raw Harness event names only for low-level diagnostics/tests if needed;
- update tests to assert projected contract, not raw event replay.

## Minimal test set

Do not create a giant matrix. These are enough to guard the cut:

1. **Scope isolation:** same `sessionId` in two directories does not share projection.
2. **Tool terminal:** completed/error never regresses to running/pending.
3. **Completed message:** `message.time.completed` finalizes pending/running tools.
4. **Delta privacy:** raw `message.part.delta` input emits `transcript.message`, never Frontend `PART_DELTA`.
5. **Hydrate/live convergence:** live→page and page→live produce same message.
6. **Frontend replacement:** `TRANSCRIPT_MESSAGE` replaces whole message; no part merge helper called.
7. **SDK parity:** `SessionHandle.messages()` and Backend message route return same projected page for same scope.

## Definition of done

- `server/transcript-projection.ts` deleted.
- `SessionTranscriptProjectionRegistry` deleted.
- No projection key omits `directory`.
- Backend has explicit `services.transcripts`.
- SDK transcript reads go through `transcripts.readPage`.
- Frontend never receives `message.part.delta` for product transcript state.
- `src/hooks` contains no transcript merge/replay/delta helpers.
- Adapter transcript caches are gone or renamed to transport-only state.
- `pnpm run slop-check`, transcript slop check, `pnpm vp test`, and `pnpm vp build` pass.

## First implementation move

Start with **Step 0 + Step 1** only:

1. add the slop guard so the target is executable;
2. create `session-transcripts.ts`;
3. delete the registry/server singleton prototype;
4. keep old wire names temporarily only until Step 4.

No more planning modules until those deletions land.
