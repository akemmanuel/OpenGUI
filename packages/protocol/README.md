# @opengui/protocol

Shared **wire types** for OpenGUI layers (no React, no Hono, no Harness adapters).

- `HarnessId` — harness catalog ids
- `OpenGuiCapabilities` — backend capability JSON
- `QueueMode`, `SelectedModel` — queue / Agent send payloads

Frontend `src/protocol/client.ts` and `server/services` should import these instead of duplicating types across `src/agents` and `src/types/electron` where only the wire shape matters.

Keep `HARNESS_ID_VALUES` in sync with `src/agents/harness-ids.ts` (or migrate that file to re-export from here).
