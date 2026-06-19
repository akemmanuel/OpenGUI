# Plan: drastically simplify Frontend Session transcript and MessageList streaming

Related context: [CONTEXT.md](../../CONTEXT.md), [ADR 0005](../adr/0005-opengui-runtime-backend-split-and-sdk.md), [ADR 0007](../adr/0007-runtime-sdk-minimal-surface.md), [live Session event unification](./live-session-event-unification.md), and [Session transcript projection](./session-transcript-projection.md).

## Intent

The OpenGUI Runtime now has a clean canonical live stream. The OpenGUI Frontend should not re-create a second messy Runtime in React state.

The drastic simplification is:

> The Frontend renders exactly one live Session transcript: the active Session. Everything else is Session activity, not message state.

That one decision lets us delete the background transcript buffers, the module-global live projection map, repeated reconcile loops that race streaming, raw Harness event compatibility in product paths, and most of the MessageList scroll machinery.

## Why the current Frontend became complicated

This is accumulated migration slop, not one bad module.

The Frontend currently tries to keep all of these true at the same time:

- render token-level live output;
- keep non-active Sessions warm in memory;
- merge live events with delayed transcript reads;
- recover from old raw Harness events;
- update sidebar activity;
- preserve scroll position through virtualized, variable-height markdown;
- track child Session transcripts eagerly;
- route every update through the large `InternalAgentState` reducer.

Those goals created too many transcript owners:

1. `src/hooks/frontend-live-session-bridge.ts` owns a module-global `LiveSessionProjection` map.
2. `src/hooks/agent-transcript-reducer.ts` owns `_transcriptRevisionBySession`, `_sessionBuffers`, and whole-message replacement.
3. `src/hooks/agent-session-activation.ts` owns message page hydration and repeated final reconcile fetches.
4. `src/hooks/agent-reducer.ts` owns active `messages`, busy state, turn binding, and session replacement/deletion cleanup.
5. `src/components/message-list/*` re-derives visibility, footers, scroll anchors, row sizes, image paths, and actions from raw transcript entries.

The result is shallow modules: each interface exposes almost the same complexity as its implementation. A token can become a whole `MessageEntry`, then a full `messages` array replacement, then a virtualizer size recalculation, then a scroll snapshot rewrite.

## Simplification rules

### Rule 1 — Active Session transcript only

The Frontend keeps message content only for the active Session.

For non-active Sessions, live events may update:

- busy/idle/error state;
- unread state;
- sidebar retain/list visibility;
- queue or interaction badges.

They must not build or maintain full background message buffers.

Delete or migrate away from:

- `_sessionBuffers` as a correctness mechanism;
- background `TRANSCRIPT_MESSAGE` upserts;
- eager child Session transcript hydration for non-visible rows.

If instant switch-back is needed later, add a tiny cache inside the new transcript module. It must be an optimization, not a source of truth.

### Rule 2 — One Frontend module owns active transcript state

Create one deep module under `src/features/session-transcript/`.

Suggested files:

```txt
src/features/session-transcript/
  active-session-transcript-store.ts
  active-session-transcript-provider.tsx
  transcript-input.ts
  transcript-row-model.ts
  transcript-viewport.tsx
  transcript-rows.tsx
```

This module owns:

- active Session scope;
- current active transcript messages;
- older-page cursor and loading state;
- live projection state;
- duplicate event guard;
- live-vs-hydrate merge rules;
- final reconcile policy;
- row model projection for rendering.

`InternalAgentState` should stop owning active transcript correctness. It can keep Session list, selection, PromptBox state, queue state, and Session activity.

### Rule 3 — No token stream through the big reducer

Do not dispatch `TRANSCRIPT_MESSAGE` for every streamed patch.

Canonical live events should enter the active transcript module and be committed on an animation frame:

```txt
LiveSessionEvent x N
  -> active transcript store mutates private draft/projection
  -> one frame commit
  -> MessageList sees one snapshot/row revision
```

The big reducer should not re-render the app shell, sidebar, prompt box, model selector, or workspace chrome on every token.

### Rule 4 — Hydration cannot clobber live text

Transcript page reads are still important, but they must merge through one policy:

- while a Session is running, page reads may add missing older messages but must not replace longer/newer live parts with shorter stale parts;
- after `run.finished`, fetch one final page after a short delay and accept it as authoritative when it includes the completed assistant turn;
- if final page is still stale, retry a small fixed number of times, not the current long reconcile ladder;
- live text never regresses unless the canonical event is an explicit `part.text.replaced` or `transcript.rebased`.

Delete the repeated reconcile ladder as a normal streaming mechanism.

### Rule 5 — Product Frontend consumes only product events

The product event gateway should map backend envelopes into a small Frontend union:

```ts
type FrontendBackendEvent =
  | { type: "session.index"; ... }
  | { type: "session.activity"; ... }
  | { type: "session.interaction"; ... }
  | { type: "queue"; ... }
  | { type: "active-transcript.live"; event: LiveSessionEvent }
  | { type: "active-transcript.snapshot"; ... }
  | { type: "active-transcript.removed"; ... };
```

Raw `HarnessEvent` casting stays diagnostics-only. Product hooks/components should not see `message.part.delta`, `message.part.updated`, or raw `session.status` except in allowed tests/adapters.

### Rule 6 — MessageList renders rows, not raw transcript entries

`MessageList` should consume a row model:

```ts
type TranscriptRow =
  | { kind: "message"; id: string; entry: TranscriptMessageEntry; spacing: string; footer?: TurnFooter; actions: RowActions; imageBaseDirectory: string | null }
  | { kind: "permission"; id: string; ... }
  | { kind: "question"; id: string; ... }
  | { kind: "revert-banner"; id: string; ... }
  | { kind: "load-older"; id: string; ... }
  | { kind: "status"; id: string; ... };
```

Rows resolve these before React rendering:

- visible content filtering;
- system-append hiding;
- revert cutoff;
- first-user-message action rules;
- fork/revert capabilities;
- turn footer metadata;
- pending permission/question placement;
- image base directory;
- expansion state.

`MessageBubble` becomes a pure view. It must not call `useSessionState()` or `useConnectionState()`.

### Rule 7 — Simplify scrolling before optimizing it

Delete the virtualized scroller for the first simplified pass unless profiling proves it is required.

Use a plain scroll container with:

- explicit `Load older` row at the top;
- bottom pinning only when the user is already near the bottom;
- prepend scroll preservation using `scrollHeight` delta;
- `content-visibility: auto` on message rows if needed;
- active-window cap from existing `limitMessageWindow`.

If virtualization is needed later, hide it behind the same `TranscriptViewport` interface. It should be an adapter, not part of transcript correctness.

### Rule 8 — Child Sessions load lazily

Task/subagent details should load when the user expands that tool row, not as part of every message hydration and streaming update.

Move child Session transcript state out of `InternalAgentState` and into a small lazy cache owned by MessageList/tool details.

Delete or migrate away from:

- global `childSessions` as normal message state;
- global `trackedChildSessionIds` as a streaming side effect;
- eager child hydration from active message page loads.

## Target flow

```txt
Backend SSE / client subscription
  -> Frontend event gateway
      -> Session activity reducer       (sidebar, busy, unread, interactions)
      -> Active Session transcript      (only if scope matches active Session)

Session selected
  -> Active Session transcript resets scope
  -> fetch first transcript page
  -> build TranscriptRow[]
  -> MessageList renders rows

LiveSessionEvent for active Session
  -> active transcript store applies event
  -> frame commit
  -> row model updates

run.finished for active Session
  -> active transcript store marks idle
  -> one final transcript page fetch
  -> authoritative final merge
```

## Module interface sketch

The exact names can change, but the interface should stay small.

```ts
type ActiveTranscriptScope = {
  directory: string;
  harnessId: string;
  sessionId: string;
};

type ActiveTranscriptInput =
  | { type: "select"; scope: ActiveTranscriptScope | null }
  | {
      type: "page.loaded";
      scope: ActiveTranscriptScope;
      messages: MessageEntry[];
      hasMore: boolean;
      nextCursor: string | null;
      phase: "initial" | "older" | "final";
    }
  | { type: "page.failed"; scope: ActiveTranscriptScope; error: string }
  | { type: "live"; event: LiveSessionEvent }
  | { type: "message.removed"; scope: ActiveTranscriptScope; messageId: string }
  | { type: "reset" };

type ActiveTranscriptSnapshot = {
  scope: ActiveTranscriptScope | null;
  phase: "empty" | "loading" | "ready" | "error";
  messages: MessageEntry[];
  rows: TranscriptRow[];
  hasOlder: boolean;
  loadingOlder: boolean;
  error: string | null;
  revision: number;
  running: boolean;
};
```

The rest of the app should know only:

- current snapshot;
- `select(scope)`;
- `loadOlder()`;
- `ingestLive(event)`;
- `reconcileFinal()`.

No caller should know whether a live event was originally a Pi snapshot, OpenCode delta, page hydrate, or final fetch.

## Implementation phases

### Phase 0 — Lock the intended behavior with failing tests

Add tests before deleting anything:

- live appends update active transcript once per frame;
- duplicate backend event ids do not duplicate text;
- stale transcript page cannot shorten live text while running;
- `run.finished` schedules final page fetch once;
- non-active live events update busy/unread but do not create message buffers;
- switching active Session drops old live scope and ignores late events;
- `MessageBubble` does not import `use-agent-state`.

### Phase 1 — Add the active transcript module beside existing code

Build `src/features/session-transcript/active-session-transcript-store.ts` as a pure module first.

It should be testable without React:

- feed inputs;
- inspect snapshots;
- assert rows/messages/revisions/effects.

Use `LiveSessionProjection` internally if useful, but keep it private to the module.

### Phase 2 — Route active live events into the new module

Change backend event subscription so canonical live events are handled as:

- active scope match -> `activeTranscript.ingestLive(event)`;
- non-active -> activity reducer only.

Stop emitting `TRANSCRIPT_MESSAGE` from `frontend-live-session-bridge.ts` for the active path. That file should either disappear or become a tiny adapter owned by the new module.

### Phase 3 — Move transcript page loading into the module

Selection calls should tell the active transcript module which Session is active. The module then owns initial page load, older-page load, and final page reconcile.

Remove direct `SET_MESSAGES` replacement from normal session activation.

### Phase 4 — Replace MessageList with row rendering

`useMessageListModel()` should return rows from the active transcript module.

Then make row views pure:

- `MessageBubble` receives `imageBaseDirectory`, `attachmentBaseUrl`, actions, footer, and expansion state as props;
- no `useSessionState()` inside row components;
- no `useConnectionState()` inside row components.

### Phase 5 — Replace the virtual scroller with a plain viewport

First simplified viewport:

- top `Load older` row;
- simple `usePinnedScroll` hook;
- preserve scroll on prepend;
- no TanStack virtualizer;
- no size estimates;
- no per-session scroll snapshot LRU.

Keep the current virtualizer file around until the new path is stable, then delete it. If performance fails, reintroduce virtualization behind `TranscriptViewport` without changing the transcript store or row model.

### Phase 6 — Delete old transcript state and actions

Remove from `InternalAgentState` if no longer used:

- `messages`;
- `messageHistoryHasMore`;
- `messageHistoryCursor`;
- `isLoadingMessages`;
- `isLoadingOlderMessages`;
- `_transcriptRevisionBySession`;
- `_sessionBuffers`;
- `childSessions`;
- `trackedChildSessionIds`.

Remove actions if no longer used:

- `SET_MESSAGES`;
- `TRANSCRIPT_MESSAGE`;
- `TRANSCRIPT_SNAPSHOT`;
- `TRANSCRIPT_MESSAGE_REMOVED`;
- `LOAD_CHILD_SESSION` for eager hydration.

Keep Session activity actions:

- `SESSION_STATUS`;
- `SESSION_ERROR`;
- `SESSION_CREATED` / `SESSION_UPDATED` / `SESSION_DELETED`;
- queue and interaction actions.

### Phase 7 — Add slop checks

Extend `scripts/slop-check.mjs` to ban these outside explicitly allowed files/tests:

- `TRANSCRIPT_MESSAGE`;
- `TRANSCRIPT_SNAPSHOT`;
- `_sessionBuffers`;
- `_transcriptRevisionBySession`;
- `new LiveSessionProjection` outside `src/features/session-transcript/`;
- `MessageBubble` importing from `use-agent-state`;
- `message.part.delta` / `message.part.updated` in `src/hooks` and `src/components`.

## What to delete aggressively

After migration, these should shrink or disappear:

- `src/hooks/frontend-live-session-bridge.ts` — no module-global projection map.
- `src/hooks/agent-transcript-reducer.ts` — replaced by active transcript store.
- `src/hooks/agent-session-activation.ts` message ownership — selection can trigger active transcript selection/fetch, not direct reducer replacement.
- `src/components/message-list/useVirtualMessageScroller.ts` — replace with simple viewport first.
- `src/components/message-list/message-scroll-position.ts` — most estimate/anchor helpers become unnecessary.
- eager child hydration paths in `src/hooks/agent-message-loading.ts` and `src/hooks/use-agent-impl-core.tsx`.

## Acceptance criteria

### Behavior

- Pi and OpenCode stream live text in the active Session without duplicate text.
- A lagging transcript page cannot make streamed text go backwards.
- When a run finishes, the Frontend performs one final transcript reconcile and settles.
- Switching away from a running Session does not maintain a background message projection.
- Switching back fetches the current transcript and resumes active live rendering.
- User scroll is not yanked to the bottom after they scroll up.
- Load older is explicit and stable.
- Task/subagent details load only when requested.

### Architecture

- Product Frontend code consumes canonical live Session events, not raw Harness part events.
- The big app reducer is not on the token hot path.
- Message rows are pure views with props, not context subscribers.
- Transcript correctness is testable through one module interface.
- `pnpm run slop-check`, `pnpm vp lint`, and targeted tests pass.

## Trade-offs

### Accepted trade-off: re-fetch on switch

Dropping background message buffers means switching back to a Session may fetch from the Backend. That is acceptable to get correctness and locality. If this feels slow, add a small private cache inside the active transcript module later.

### Accepted trade-off: plain scroll first

Virtualization can be reintroduced, but it should not be part of transcript correctness. A plain viewport is much easier to reason about while streaming behavior is being fixed.

### Accepted trade-off: child details lazy-load

Subagent/tool details may open with a small loading state. That is better than global eager child transcript state mutating during every stream.

## Top-level decision

Make the Frontend less clever:

- one active transcript;
- one transcript owner;
- one row model;
- no token stream through global app state;
- no background message buffers;
- no raw Harness events in product paths;
- no virtual scroller until profiling earns it.
