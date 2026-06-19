# Plan: cut harness-specific live event slop out of OpenGUI

Domain terms: [CONTEXT.md](../../CONTEXT.md). Decisions to preserve: [ADR 0005](../adr/0005-opengui-runtime-backend-split-and-sdk.md), [ADR 0007](../adr/0007-runtime-sdk-minimal-surface.md), and [session transcript projection plan](./session-transcript-projection.md).

## Intent

OpenGUI should have exactly one public live-event language for running Sessions. Pi, OpenCode, Claude Code, Codex, and future Harnesses can report progress however they want, but that weirdness must die inside the OpenGUI Runtime. The OpenGUI SDK, OpenGUI Backend, OpenGUI Frontend, and debug scripts should not know whether a Harness reported a text delta, a full-part snapshot, repeated status events, or a message replacement.

The current implementation leaks too much Harness Adapter shape:

- SDK users can subscribe to `harness.on("event")` and receive Runtime-internal `HarnessEvent` objects.
- `SessionHandle.onStream()` is only partially normalized and misses Pi text/thinking progress because Pi mostly emits full `message.part.updated` snapshots.
- OpenCode emits duplicate-ish status/update events, and those become repeated `run.start` / `run.end` events.
- `SessionHandle.waitUntilIdle()` currently subscribes to Harness events and calls the same dispatch path as `onStream()`, so the documented `onStream()` + `waitUntilIdle()` pattern can duplicate stream events.
- Frontend-oriented event names (`message.part.updated`, `message.part.delta`, `message.replaced`, `session.status`) are used as if they were the Runtime's public event contract.
- Debug tooling has to show both “raw” and SDK events to explain what happened, which proves the seam is shallow.

The target is a deep Runtime module that absorbs all of this and exposes one canonical **Live Session stream**.

## Hard rules

1. **One public live event contract:** Product and SDK consumers receive `LiveSessionEvent`, not `HarnessEvent`.
2. **Harness Adapter weirdness stops at the Runtime seam:** Adapter-native deltas, snapshots, repeated statuses, and replacement quirks are private input to the normalizer.
3. **No raw Harness events in normal SDK APIs:** `harness.on("event")` must not be documented as an SDK event stream; eventually remove it or move it under diagnostics.
4. **No Frontend Harness-specific live reconciliation:** Frontend reducers consume projected live events/messages, not `message.part.delta` or Harness-specific part snapshots.
5. **No durable transcript cache:** live projections are in-memory progress views only. Session transcript truth remains Harness-owned and is recovered by Session message page reads.
6. **No duplicate lifecycle events:** repeated `running` / `busy` observations produce one `run.started`; repeated `idle` observations produce one `run.finished`.
7. **Snapshots become semantic patches:** progressive full-part snapshots become text/thinking appends when prefix-compatible, or text/thinking replacements when the Harness rewrites content.
8. **One place owns normalization state:** no duplicated status/delta/snapshot reconciliation in adapters, SDK handles, Backend SSE code, Frontend hooks, or debug scripts.

## What we noticed during the Pi/OpenCode debug

### OpenCode

OpenCode with `nvidia/openai/gpt-oss-120b` works end-to-end:

- session creation succeeds;
- prompt send succeeds;
- model selection is reflected in transcript readback;
- final assistant text is correct;
- Harness-native streaming emits many `message.part.delta` events.

But the live event stream is noisy:

- `session.created` appeared twice;
- several `message.updated` and `message.part.updated` events appeared twice;
- multiple `session.status: busy` events appeared for one run;
- multiple `session.status: idle` events appeared at the end;
- SDK `onStream()` exposed multiple `run.start` and `run.end` events for one logical send.

This means OpenCode's adapter observations are usable, but they are not a public event contract.

### Pi

Pi does not expose `nvidia/openai/gpt-oss-120b`; the available matching model is `nvidia/openai/gpt-oss-20b`.

With `nvidia/openai/gpt-oss-20b`, Pi works end-to-end:

- session creation succeeds;
- prompt send succeeds;
- model selection is reflected in transcript readback;
- final assistant text is correct.

But Pi mostly reports progressive full-part snapshots:

- reasoning part length grows over time;
- text part length grows over time;
- the current SDK normalized stream only exposes lifecycle events for this path;
- no `text.delta` or `thinking.delta` is produced even though live progress exists at the Harness-event level.

This means Pi is streaming, but the SDK normalizer is too shallow to turn snapshots into unified progress events.

### Cross-Harness conclusion

OpenCode and Pi are doing different mechanical things to report the same product concept: a Session run produced thinking text and assistant text. OpenGUI should expose the product concept, not the mechanics.

## Target architecture

Current rough shape:

```txt
Harness native event
  -> Harness Adapter
  -> HarnessEvent-ish object
  -> Backend / SDK / Frontend / debug script
  -> scattered normalization/reconciliation
```

Target shape:

```txt
Harness native event
  -> Harness Adapter
  -> AdapterObservation          private Runtime input
  -> LiveSessionEventNormalizer  one stateful owner
  -> LiveSessionEvent            public Runtime contract
  -> SDK / Backend / Frontend / debug script
```

The important cut is between **AdapterObservation** and **LiveSessionEvent**.

- `AdapterObservation` is allowed to be ugly enough to represent Harness realities.
- `LiveSessionEvent` must be clean enough for SDK users and Frontend rendering.

## Canonical public contract: `LiveSessionEvent`

Add a new Runtime-owned event contract, versioned from day one.

```ts
interface LiveSessionEventBase {
  version: 1;
  id: string;
  seq: number;
  scope: {
    directory: string;
    harnessId: HarnessId;
    sessionId: string;
  };
  runId?: string;
  messageId?: string;
  partId?: string;
  time: { observed: number };
}
```

Initial event union:

```ts
type LiveSessionEvent =
  | RunStarted
  | RunFinished
  | MessageStarted
  | MessageFinished
  | PartStarted
  | PartTextAppended
  | PartTextReplaced
  | PartStateChanged
  | ToolStarted
  | ToolInputUpdated
  | ToolOutputAppended
  | ToolOutputReplaced
  | ToolFinished
  | TranscriptRebased
  | SessionError;
```

Recommended concrete names:

```ts
type LiveSessionEventType =
  | "run.started"
  | "run.finished"
  | "message.started"
  | "message.finished"
  | "part.started"
  | "part.text.appended"
  | "part.text.replaced"
  | "part.state.changed"
  | "tool.started"
  | "tool.input.updated"
  | "tool.output.appended"
  | "tool.output.replaced"
  | "tool.finished"
  | "transcript.rebased"
  | "session.error";
```

### Why append and replace both exist

Append-only deltas are not honest enough. Some Harnesses report snapshots, and snapshots can rewrite content.

Prefix-compatible snapshot:

```txt
"OP"
"OPENG"
"OPENGUI"
```

becomes:

```ts
part.text.appended "OP"
part.text.appended "ENG"
part.text.appended "UI"
```

Non-prefix rewrite:

```txt
"I will use rg"
"I will inspect package.json"
```

becomes:

```ts
part.text.replaced {
  text: "I will inspect package.json",
  reason: "snapshot-rewrite"
}
```

Consumers get one unified semantic stream without pretending all Harnesses are delta-native.

## Private Runtime input: `AdapterObservation`

Adapters should emit observations, not public events.

```ts
type AdapterObservation =
  | {
      kind: "activity";
      scope: LiveSessionScope;
      state: "running" | "idle" | "error";
      source?: AdapterObservationSource;
    }
  | {
      kind: "message.snapshot";
      scope: LiveSessionScope;
      message: NormalizedMessageSnapshot;
      source?: AdapterObservationSource;
    }
  | {
      kind: "part.snapshot";
      scope: LiveSessionScope;
      messageId: string;
      part: NormalizedPartSnapshot;
      source?: AdapterObservationSource;
    }
  | {
      kind: "part.delta";
      scope: LiveSessionScope;
      messageId: string;
      partId: string;
      partKind: "text" | "thinking";
      text: string;
      source?: AdapterObservationSource;
    }
  | {
      kind: "tool.snapshot";
      scope: LiveSessionScope;
      messageId: string;
      part: NormalizedToolSnapshot;
      source?: AdapterObservationSource;
    }
  | {
      kind: "transcript.replaced";
      scope: LiveSessionScope;
      reason: "harness-replaced-message" | "reconnect" | "final-read";
      source?: AdapterObservationSource;
    }
  | {
      kind: "error";
      scope: LiveSessionScope;
      message: string;
      source?: AdapterObservationSource;
    };
```

`source` is optional diagnostic metadata for safe dedupe:

```ts
interface AdapterObservationSource {
  harnessId: HarnessId;
  nativeType?: string;
  nativeEventId?: string;
  transport?: "sse" | "sdk-callback" | "jsonl" | "poll" | "synthetic";
}
```

This type is private to Runtime/adapters. It should not be exported from the top-level SDK.

## Deep module to add

Create one Runtime module family:

```txt
packages/runtime/src/live-session-events/
  live-session-event.ts
  adapter-observation.ts
  live-session-normalizer.ts
  live-session-projection.ts
  live-session-event-bus.ts
  live-session-event-compat.ts
```

### `live-session-event.ts`

Owns public types:

- `LiveSessionEvent`
- `LiveSessionEventType`
- `LiveSessionScope`
- `LiveSessionEventHandler`

This is the type package consumers should see.

### `adapter-observation.ts`

Owns private adapter input types. Keep it outside package top-level exports.

### `live-session-normalizer.ts`

The stateful brain.

```ts
class LiveSessionEventNormalizer {
  ingest(observation: AdapterObservation): LiveSessionEvent[];
  snapshot(scope: LiveSessionScope): LiveSessionProjectionSnapshot | null;
  evict(scope: LiveSessionScope): void;
}
```

State per Harness Scope:

```ts
interface LiveSessionNormalizerState {
  seq: number;
  activity: "idle" | "running" | "error";
  currentRunId?: string;
  runCounter: number;
  messages: Map<string, MessageState>;
  parts: Map<string, PartState>;
  recentObservationFingerprints: LruSet<string>;
}
```

### `live-session-projection.ts`

Applies `LiveSessionEvent` to an in-memory display projection.

```ts
class LiveSessionProjection {
  apply(event: LiveSessionEvent): void;
  getMessages(): MessageEntry[];
  getStatus(): { type: "idle" | "running" | "error" };
}
```

Frontend and debug scripts should use projections instead of rebuilding transcript state from Harness events.

### `live-session-event-bus.ts`

Owns subscriptions and scoped dispatch.

```ts
interface LiveSessionEventBus {
  publish(observations: AdapterObservation[]): void;
  onScope(scope: LiveSessionScope, handler: LiveSessionEventHandler): () => void;
  onHarness(harnessId: HarnessId, handler: LiveSessionEventHandler): () => void;
}
```

The bus owns the normalizer, so no caller can bypass central dedupe/state.

### `live-session-event-compat.ts`

Temporary migration shim:

```ts
function harnessEventToAdapterObservations(input: {
  directory: string;
  harnessId: HarnessId;
  event: HarnessEvent;
}): AdapterObservation[];
```

This lets us migrate consumers before rewriting every adapter.

## Normalization algorithms

### Activity to run lifecycle

Adapter observations may contain repeated activity states.

Input:

```txt
running, running, running, idle, idle
```

Output:

```txt
run.started, run.finished
```

Rules:

```ts
if previous !== "running" && next === "running":
  currentRunId = `${sessionId}:run:${++runCounter}`
  emit "run.started"

if previous === "running" && next === "idle":
  emit "run.finished" with reason "idle"
  currentRunId = undefined

if previous === "running" && next === "error":
  emit "run.finished" with reason "error"
  emit "session.error" if error detail exists
  currentRunId = undefined
```

### Snapshot to append/replace

For text/thinking parts:

```ts
previous = partState.text ?? "";
next = snapshot.text ?? "";

if next === previous:
  emit nothing
else if next.startsWith(previous):
  emit "part.text.appended" with next.slice(previous.length)
else:
  emit "part.text.replaced" with next
```

This is what makes Pi and OpenCode equivalent at the public seam.

### Delta ingestion

For delta-native Harnesses:

```ts
partState.text += delta.text;
emit "part.text.appended" with delta.text;
```

If a final snapshot later arrives with the same text, emit nothing.

If the final snapshot differs, emit `part.text.replaced`.

### Part lifecycle

When seeing a new part ID:

```ts
emit "part.started"
```

Then emit text/tool/state events as needed.

Do not emit repeated `part.started` for the same part.

### Message lifecycle

When seeing a new assistant/user message ID:

```ts
emit "message.started"
```

When a Harness marks a message complete, or the run finishes and no explicit completion was observed:

```ts
emit "message.finished"
```

Do not block v1 on perfect message completion. `message.finished` can be best-effort.

### Tool lifecycle

Normalize tool parts into:

```txt
tool.started
tool.input.updated
tool.output.appended / tool.output.replaced
tool.finished
```

Tool output uses the same append/replace algorithm as text parts.

Start with minimal support:

- running/pending -> `tool.started`
- completed/error/failed -> `tool.finished`
- input snapshot -> `tool.input.updated`
- output text snapshot -> append/replace

Do not try to model every Harness-specific tool state in the public contract.

## ID rules

### Scope key

The normalizer key is exactly:

```ts
{
  (directory, harnessId, sessionId);
}
```

No missing directory. No workspace ID. No fallback key.

### Message and part IDs

Prefer native stable IDs. If missing, synthesize deterministic live IDs:

```ts
messageId = `${sessionId}:run:${runCounter}:assistant:${assistantIndex}`;
partId = `${messageId}:part:${partIndex}:${partKind}`;
```

Do not expose Harness-native unstable IDs if they are known to churn. Stable Runtime IDs are better than false-native IDs.

### Event IDs and sequence

Each normalized event gets:

```ts
seq = ++state.seq;
id = `${scope.sessionId}:live:${seq}`;
```

This is enough for live streams. Do not design a durable event-store ID scheme in this phase.

## SDK target

Add canonical event subscription:

```ts
session.onEvent((event: LiveSessionEvent) => {});
```

Keep old stream helper temporarily:

```ts
session.onStream((event: AgentStreamEvent) => {});
```

But implement it as a projection from `LiveSessionEvent`, not from `HarnessEvent`.

Old mapping:

```txt
HarnessEvent -> AgentStreamEvent
```

New mapping:

```txt
AdapterObservation -> LiveSessionEvent -> AgentStreamEvent
```

`AgentStreamEvent` becomes a legacy/ergonomic simplified stream, not the primary event truth.

### Fix `waitUntilIdle()`

`waitUntilIdle()` must not dispatch to user stream handlers.

It should observe central Runtime status state or wait for `run.finished` internally.

Rules:

- no calls to the user-facing stream dispatch path;
- no second subscription that emits to the same handlers;
- if `onEvent()` is active, `waitUntilIdle()` does not change what it receives.

## Backend target

Backend live transport should eventually send `LiveSessionEvent`, not `HarnessEvent`.

Short-term migration:

```txt
bridge-event -> normalizeBridgeEvent -> HarnessEvent -> compat -> AdapterObservation -> LiveSessionEvent -> transport
```

Long-term target:

```txt
adapter -> AdapterObservation -> LiveSessionEvent -> transport
```

The Backend can still send separate non-live operational events when needed, but running Session progress should be unified.

## Frontend target

Frontend should not reduce `message.part.delta` or `message.part.updated` directly.

Frontend options:

### Preferred

Frontend consumes `LiveSessionEvent` and applies `LiveSessionProjection`.

### Acceptable migration intermediate

Backend applies `LiveSessionProjection` and sends message-level projected transcript events:

```ts
type ProjectedTranscriptEvent =
  | { type: "transcript.snapshot"; scope; revision; page }
  | { type: "transcript.message"; scope; revision; entry }
  | { type: "transcript.message.removed"; scope; revision; messageID };
```

This aligns with the existing [session transcript projection plan](./session-transcript-projection.md). Either way, raw part deltas do not reach Frontend product state.

## Debug CLI target

Default CLI output should show only canonical events and final transcript.

Example:

```txt
OpenGUI Live Session Debug
directory: /home/emmanuel/Code/OpenGUI

▶ opencode nvidia/openai/gpt-oss-120b
  event run.started
  event message.started assistant
  event part.started thinking
  event part.text.appended thinking "The user wants exactly..."
  event part.started text
  event part.text.appended text "OPENGUI_STREAM_OK"
  event run.finished idle

Transcript
  #1 user nvidia/openai/gpt-oss-120b
    text: Reply with exactly: OPENGUI_STREAM_OK
  #2 assistant nvidia/openai/gpt-oss-120b
    thinking: The user wants exactly...
    text: OPENGUI_STREAM_OK

Summary: PASS
```

Raw adapter observations can exist behind an explicit flag only:

```bash
--debug-adapter-observations
```

No normal user-facing command should show `message.part.updated`, `message.part.delta`, or `session.status`.

## Cut plan

### Phase 0 — name and freeze the intended seam

- Add this plan.
- Update Runtime README to say the stable live stream is `LiveSessionEvent` once implemented.
- Mark `harness.on("event")` as internal/diagnostic in docs or remove it from public examples.

### Phase 1 — add canonical types and normalizer over existing events

Add:

```txt
packages/runtime/src/live-session-events/live-session-event.ts
packages/runtime/src/live-session-events/adapter-observation.ts
packages/runtime/src/live-session-events/live-session-normalizer.ts
packages/runtime/src/live-session-events/live-session-event-compat.ts
```

Use current `HarnessEvent` only as compatibility input.

Tests first:

- OpenCode repeated busy/idle emits one `run.started` and one `run.finished`.
- Pi progressive snapshots emit `part.text.appended` events.
- repeated identical snapshots emit nothing.
- non-prefix snapshots emit `part.text.replaced`.

### Phase 2 — expose `SessionHandle.onEvent()`

Add:

```ts
session.onEvent(handler: LiveSessionEventHandler): () => void;
```

Internally:

```txt
HarnessEvent -> compat observations -> LiveSessionEventNormalizer -> onEvent handlers
```

Keep `onStream()` but derive it from `onEvent()`.

### Phase 3 — fix `waitUntilIdle()`

Remove duplicate dispatch behavior.

Acceptance test:

```ts
session.onEvent(record);
await session.send(...);
await session.waitUntilIdle();
expect(count("run.started")).toBe(1);
expect(count("run.finished")).toBe(1);
```

Repeat with `onStream()` for backwards compatibility.

### Phase 4 — clean debug CLI

Update `scripts/runtime/debug-bridges.mjs`:

- default to `session.onEvent()`;
- render canonical events only;
- final transcript via `session.messages()`;
- raw diagnostics only through `--debug-adapter-observations`.

This becomes the human proof that the event seam is deep.

### Phase 5 — route Backend live streams through the normalizer

Backend receives current bridge events, but before publishing live Session progress:

```txt
HarnessEvent -> AdapterObservation -> LiveSessionEvent
```

Transport `LiveSessionEvent` to clients.

Do not delete old transport immediately. Add a temporary compatibility path for the current Frontend if needed.

### Phase 6 — move Frontend off raw part events

Frontend should consume either:

- `LiveSessionEvent` + `LiveSessionProjection`, or
- Backend-projected message-level transcript events.

Delete Frontend code that knows about:

- `message.part.delta`;
- `message.part.updated` as a live protocol primitive;
- local delta merge cursors;
- local progressive snapshot reconciliation;
- local tool finalization policy that belongs in Runtime projection.

### Phase 7 — make Harness Adapters emit `AdapterObservation` directly

One adapter at a time:

1. Pi
2. OpenCode
3. Claude Code
4. Codex
5. Grok Build

For each adapter:

- map native events to `AdapterObservation`;
- delete adapter code that tries to mimic public event semantics;
- keep only Harness-specific extraction logic;
- prove with golden trace tests.

### Phase 8 — demote/remove `HarnessEvent` from public paths

After SDK, Backend, and Frontend are on `LiveSessionEvent`:

- rename old `HarnessEvent` to `InternalHarnessEvent` if still needed;
- remove it from SDK exports;
- remove `harness.on("event")` or move it under explicit diagnostics;
- add slop checks to prevent `message.part.delta` and `message.part.updated` from returning to public SDK/Frontend paths.

## Slop checks to add

Extend `pnpm run slop-check` with live-event guards.

Fail on new public/default usage of:

```txt
harness.on("event") in README/examples/scripts except diagnostics
message.part.delta in src/hooks
message.part.updated in src/hooks
session.status used to render run lifecycle outside Runtime normalizer
harnessEventToAgentStreamEvents outside compatibility module
dispatchMapped(event) inside waitUntilIdle
```

Allow `message.part.*` inside:

```txt
packages/runtime/src/adapters/**
packages/runtime/src/live-session-events/live-session-event-compat.ts
packages/runtime/src/session-transcripts.ts while migration is active
tests/fixtures/**
```

## Test matrix

### Golden traces

Create fixtures:

```txt
packages/runtime/src/live-session-events/__fixtures__/
  pi-basic-snapshot-run.json
  pi-snapshot-rewrite.json
  opencode-basic-delta-run.json
  opencode-duplicate-status.json
  claude-tool-use.json
  codex-tool-delta.json
```

Each fixture asserts `LiveSessionEvent` output and final projection.

### Cross-Harness equivalence

Given equivalent Pi snapshots and OpenCode deltas, final projection must match:

```txt
assistant thinking: ...
assistant text: OPENGUI_STREAM_OK
status: idle
```

The exact chunk boundaries may differ; the projection must not.

### SDK tests

- `onEvent()` receives canonical events only.
- `onStream()` still works as a compatibility helper.
- `waitUntilIdle()` does not duplicate user events.
- Pi snapshots produce text/thinking progress.
- OpenCode duplicate statuses produce one run lifecycle pair.

### Backend tests

- Backend live stream publishes `LiveSessionEvent`.
- missing Harness Scope logs/drops instead of publishing unscoped raw events.
- reconnect + message page read can repair live projection gaps.

### Frontend reducer tests

- no direct part delta reducer path remains.
- applying canonical events/projections updates messages correctly.
- repeated events do not duplicate text.

## Acceptance criteria

This plan is done when:

1. A script can run Pi and OpenCode and show the same canonical event vocabulary for both.
2. Pi live text/thinking progress appears through the SDK without exposing `message.part.updated`.
3. OpenCode repeated status/update noise does not create duplicate public run lifecycle events.
4. `waitUntilIdle()` does not duplicate `onEvent()` or `onStream()` output.
5. Frontend product state does not consume raw `message.part.delta` events.
6. SDK docs do not tell users to subscribe to Harness-level raw events.
7. The only place that knows Pi uses snapshots and OpenCode uses deltas is Runtime adapter/normalizer code.

## Non-goals

- Do not build a durable event store.
- Do not make OpenGUI Backend own Session transcript truth.
- Do not add SDK queue parity; Queued prompts remain Backend-owned.
- Do not block text/thinking normalization on perfect tool modeling.
- Do not rewrite every Harness Adapter before proving the compatibility normalizer.

## Top recommendation

Start with the compatibility normalizer and SDK `session.onEvent()`.

That gives immediate leverage:

- fixes Pi streaming at the SDK seam;
- dedupes OpenCode lifecycle noise;
- fixes the debug CLI;
- avoids a risky all-adapter rewrite;
- creates the deep Runtime module that later lets us delete raw event slop from Backend and Frontend.
