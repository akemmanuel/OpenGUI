# Root cause: Pi/OpenCode send-message findings

## Executive summary

OpenCode with Nvidia `openai/gpt-oss-120b` **does work** at the harness/backend level. The apparent “stuck” behavior in the web UI is caused by **mis-scoped OpenCode live events** when multiple OpenCode project connections exist.

The backend sends the same OpenCode daemon event through several `OpenCodeConnection` wrappers. Each wrapper stamps the event with its own directory. The transcript scope resolver then caches/uses the wrong directory (for example `/home/emmanuel`) for an OpenGUI session that actually belongs to `/home/emmanuel/Code/OpenGUI`. The frontend correctly ignores those live events because they are outside the active project scope, so the composer/sidebar remain busy and the assistant text is missing until a later manual reconcile/abort reloads messages.

## Evidence

### Harness/backend works

Runtime smoke test using OpenCode + Nvidia succeeded:

```text
▶ opencode nvidia/openai/gpt-oss-120b
status: PASS
final: OPENGUI_STREAM_OK
used: nvidia/openai/gpt-oss-120b
```

The web API also has the completed message for the “stuck” browser session:

```json
{
  "role": "assistant",
  "providerID": "nvidia",
  "modelID": "openai/gpt-oss-120b",
  "finish": "stop",
  "parts": [{ "type": "text", "text": "READY" }]
}
```

### SSE/live events are scoped to the wrong directory

For a session created with request directory `/home/emmanuel/Code/OpenGUI`, the SSE stream emitted live transcript events like:

```json
{
  "type": "run.started",
  "directory": "/home/emmanuel",
  "sessionId": "opencode:ses_...",
  "payload": {
    "scope": {
      "directory": "/home/emmanuel",
      "harnessId": "opencode",
      "sessionId": "opencode:ses_..."
    }
  }
}
```

But the same session update also appears with the real session directory in its payload:

```json
{
  "type": "session.updated",
  "directory": "/home/emmanuel/Code/finance",
  "payload": {
    "session": {
      "directory": "/home/emmanuel/Code/OpenGUI",
      "_projectDir": "/home/emmanuel/Code/OpenGUI"
    }
  }
}
```

That proves the same OpenCode event is being rebroadcast by unrelated project connections and stamped with those connections’ directories.

## Code path causing it

1. `packages/runtime/src/adapters/opencode-bridge.ts`
   - `createConnection(... directory ...)` registers an OpenCode SSE listener per connection.
   - The callback blindly does:

   ```ts
   sendEvent(sender, { ...event, directory, workspaceId });
   ```

   Since the OpenCode server event stream is effectively global, every connected project wrapper can receive the same session event and stamp it with its own `directory`.

2. `server/web-server.ts`
   - `broadcast()` calls `resolveTranscriptScopeForBridgeEvent(...)` using `bridgeDirectoryHintFromRaw(data)`.

3. `server/services/transcript-bridge-scope.ts`
   - It first tries `services.sessions.getSession(sessionId, { harnessId })` without a directory.
   - If a wrong-directory record was warmed first, transcript live events get scoped to that wrong directory.

4. Frontend filtering is then correct but fatal:
   - `dispatchLiveSessionActivity()` rejects live events whose `scope.directory` is not in the expected project keys.
   - `store.ingestLive()` also requires `scopeFromLiveEvent(event)` to equal the active transcript scope.

Result: OpenCode completes, but the UI misses `part.text.appended` and `run.finished` for the active OpenGUI scope.

## Why Pi looked related

Pi itself is not hitting this same OpenCode multi-connection scoping bug. A controlled Pi run with `nvidia-nim/openai/gpt-oss-120b` emitted correctly scoped events under `/home/emmanuel/Code/OpenGUI` and completed:

```text
run.started scope.directory=/home/emmanuel/Code/OpenGUI
part.text.appended "OPENGUI_STREAM_OK"
run.finished reason=idle
```

The earlier Pi “stuck” observation was misleading: the screenshot actually shows `READY`; the remaining spinner/stop state needs separate UI-state checking, but Pi’s backend event scope was correct in the controlled run.

## Fix direction

Do not let every OpenCode connection rebroadcast every daemon event with its own directory.

Best options:

1. In `opencode-bridge.ts`, before `sendEvent(sender, { ...event, directory, workspaceId })`, derive the event’s real session directory (`event.session.directory`, `event.message.path.cwd`, or session cache) and only send it from the matching connection.
2. In `resolveTranscriptScopeForBridgeEvent`, prefer explicit directory hints only when they match the session’s actual runtime directory, and do not resolve cached sessions by `{ harnessId }` alone for OpenCode transcript events.
3. Make `SessionDispatchIndex` resolution for raw IDs directory-strict in transcript/control paths; avoid accepting the latest same-raw-id record across unrelated directories.

The key invariant: a live event for `opencode:ses_X` must have the same `scope.directory` as the session’s actual project directory, otherwise the React transcript/busy-state pipeline will intentionally drop it.
