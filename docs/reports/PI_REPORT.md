# Pi Bridge Debug Report

Date: 2026-06-19  
Workspace: `/home/emmanuel/Code/OpenGUI`  
SDK: `@opengui/runtime` in-process OpenGUI SDK

## Requested model

- Initial requested provider/model: `nvidia` / `openai/gpt-oss-120b`
- Pi `loadResources()` result for 120b: **model not available** in Pi's NVIDIA catalog.
- Retested with available Pi model: `nvidia` / `openai/gpt-oss-20b`.

## What I tested

- Runtime creation with `createOpenGUI({ allowedRoots: [repo] })`.
- Directory connection through `og.at(repo).connect({ harnesses: ["pi"] })`.
- Harness readiness via `diagnose()` / inventory: Pi CLI reported ready.
- `loadResources()` model/provider discovery.
- `sessions.create()`.
- `session.send()` using the requested model.
- `session.messages()` after the failed send.
- Harness event subscription and SDK `session.onStream()` subscription.

## Findings

### Readiness and basic SDK operations

Pi is discoverable and ready at the inventory level. Directory connection succeeds, resources load, and session creation succeeds.

### Sending with 20b model

Sending with `nvidia/openai/gpt-oss-20b` works end-to-end. The prompt was accepted, the session reached idle, and transcript readback showed the requested model was used:

- User message model: `{ providerID: "nvidia", modelID: "openai/gpt-oss-20b", variant: "medium" }`
- Assistant message provider/model: `nvidia` / `openai/gpt-oss-20b`
- Assistant output: `OPENGUI_STREAM_OK`

The earlier 120b failure is expected from the current Pi catalog data, not a transport failure. The bridge correctly rejects an unavailable model before sending a request.

### Streaming

Pi emits full `message.part.updated` events rather than `message.part.delta` text deltas. The SDK stream therefore exposed only run lifecycle events in this test:

- `run.start`: 2
- `run.end`: 2
- `text.delta`: 0
- `thinking.delta`: 0

Underlying harness events did stream progressively: many `message.part.updated` events showed reasoning/text part lengths increasing until the final text reached `OPENGUI_STREAM_OK`.

There is the same SDK duplication symptom seen in OpenCode: using `session.onStream()` together with `session.waitUntilIdle()` produced duplicate run lifecycle events.

### Other behavior

- `sessions.create()` returned a Pi-prefixed SDK session id, e.g. `pi:<uuid>`.
- `session.messages()` returned the expected transcript page shape with `messages`, `nextCursor`, and `revision`.
- Harness event subscription emitted connection/status, session status, message updates, part updates, and `message.replaced` events.

## Verdict

With Pi's available `nvidia/openai/gpt-oss-20b` model, the Pi bridge works end-to-end: model selection, send, idle wait, and transcript readback all succeed. Streaming behavior is harness-dependent: Pi streams progressive full-part updates at the harness layer, but the SDK's normalized `onStream()` surface currently maps only run lifecycle events for those updates, not text/reasoning deltas. The SDK also duplicates run lifecycle events when `onStream()` and `waitUntilIdle()` are used together.
