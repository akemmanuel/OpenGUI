# Define storage source-of-truth boundaries

OpenGUI must keep storage responsibilities explicit across Frontend, Backend, and Harness layers. Earlier implementation paths mixed frontend local storage, in-memory routing maps, backend-adjacent adapter state, and Harness state in ways that made it unclear which layer owned Sessions, messages, Projects, queues, and UI presentation.

## Status

superseded by ADR-0010

## Decision

- The **Harness** is the only source of truth for Sessions and Session transcripts. Listing Sessions for a Project calls the relevant Harness. Requesting messages for a Session calls the relevant Harness. OpenGUI does not persist durable Session-list caches, message caches, or rebuildable routing hints.
- The **OpenGUI Frontend** uses one frontend persistence abstraction for durable per-device presentation, connection, preference, and local-intent state. App code must not scatter direct `localStorage`, IndexedDB, or other storage calls. Frontend persistence restores UI shape; it does not mirror backend canonical data.
- The **OpenGUI Backend** uses SQLite as its persistence boundary for OpenGUI-owned shared state that the Harness does not own.
- Backend SQLite is scoped to one OpenGUI Backend instance. It must not store Frontend Workspace identity, Project navigation membership, Session lists, Session transcripts, or Session routing caches.
- **Queued prompts** are backend-owned SQLite records because they are shared Session-level intent before the Harness receives them. Each queued prompt stores its own full target: Harness, Project directory, and Harness Session ID. This target is execution intent, not a general Session cache.
- Queue APIs use explicit full targets rather than naked Session IDs.
- After successful Queue dispatch, the queued prompt record is deleted. The resulting transcript state exists only in the Harness. Failed dispatches remain as failed queue items until the user retries, edits, or deletes them.
- Temporary in-memory UI buffers for recently viewed Sessions/messages are allowed for responsiveness, but they must never become durable storage or a source of truth.

## Considered Options

- **Persist Sessions and messages in OpenGUI SQLite**: rejected because it creates a second canonical store beside the Harness and risks stale transcripts, phantom Sessions, and reconciliation complexity.
- **Persist rebuildable Session routing hints**: rejected because even non-authoritative hints invite backend behavior that guesses where a Session belongs instead of using explicit Harness Scope from the current operation.
- **Keep queues frontend-local**: rejected because Queued prompts are shared Session-level intent and must survive reloads/window close and be visible to other Frontends connected to the same OpenGUI Backend.
- **Use multiple frontend storage mechanisms directly**: rejected because it scatters persistence policy across the app and makes Desktop/Web/Mobile behavior diverge.
- **Use Backend SQLite for frontend Workspaces and Project membership**: rejected because Workspace and Project navigation membership are Frontend presentation concepts, not Backend domain identity.

## Consequences

- Frontend startup restores Workspaces, Projects, UI metadata, drafts, and selection bookmarks, then refreshes Session lists and messages from the Harness.
- Backend startup opens SQLite and restores OpenGUI-owned queues/settings/uploads, but not Sessions or messages.
- Any operation that needs a Session target must carry enough current Harness Scope to reach the Harness directly.
- `lastActiveSessionId` and similar frontend values are only selection bookmarks. They must be validated against Harness results before use and must not create phantom Sessions.
- Existing frontend queue state should be migrated toward a backend queue API backed by SQLite.
- Existing backend in-memory Session-to-Project routing caches should not become persistent storage and should be reduced where explicit targets can replace them.
