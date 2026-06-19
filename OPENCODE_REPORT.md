# OpenCode Bridge Debug Report

Date: 2026-06-19  
Workspace: `/home/emmanuel/Code/OpenGUI`  
SDK: `@opengui/runtime` in-process OpenGUI SDK

## Requested model

- Requested provider/model: `nvidia` / `openai/gpt-oss-120b`
- OpenCode `loadResources()` result: **model available**.
- Observed provider count: 8.
- OpenCode local server: connected on `http://127.0.0.1:4096`, version `1.14.48`.

## What I tested

- Runtime creation with `createOpenGUI({ allowedRoots: [repo] })`.
- Directory connection through `og.at(repo).connect({ harnesses: ["opencode"] })`.
- Harness readiness via `diagnose()` / inventory: OpenCode CLI reported ready.
- `loadResources()` model/provider discovery.
- `sessions.create()`.
- `session.send("Reply with exactly: OPENGUI_STREAM_OK", { model })`.
- `session.onStream()` while waiting with `session.waitUntilIdle()`.
- `session.messages()` transcript readback.

## Findings

### Readiness and basic SDK operations

OpenCode is discoverable and ready. The bridge starts/connects to the local OpenCode server, creates a session, accepts a prompt, waits to idle, and reads messages successfully.

### Model selection

The requested model was used. Transcript readback showed:

- User message model: `{ providerID: "nvidia", modelID: "openai/gpt-oss-120b" }`
- Assistant message provider/model: `nvidia` / `openai/gpt-oss-120b`

The assistant replied with the expected exact text: `OPENGUI_STREAM_OK`.

### Streaming

Streaming works, but there is a correctness issue when using the SDK in the documented pattern (`onStream()` + `waitUntilIdle()`): events are duplicated.

Observed normalized SDK stream event counts:

- `run.start`: 6
- `text.delta`: 40
- `run.end`: 3

Observed underlying harness delta count was lower (`message.part.delta`: 20), so the SDK stream delivered duplicate deltas while `waitUntilIdle()` was active. This likely comes from `session-handle.ts`: `waitUntilIdle()` installs its own harness event subscription and calls `dispatchMapped(event)`, while `onStream()` already has an active subscription. The documented usage therefore double-dispatches stream events to stream handlers during the wait.

### Other behavior

- `sessions.create()` returned an OpenCode-prefixed SDK session id, e.g. `opencode:<raw-session-id>`.
- `session.messages()` returned the expected transcript page shape with `messages`, `nextCursor`, and `revision`.
- Run lifecycle reaches idle correctly.
- Harness events include connection status, session creation/updates, message updates, part updates, status transitions, and deltas.

## Verdict

The OpenCode bridge works end-to-end with `nvidia/openai/gpt-oss-120b`: model selection, send, idle wait, and transcript readback all succeed. Streaming is functional but **not fully correct** in the SDK's documented `onStream()` + `waitUntilIdle()` flow because stream events are duplicated.
