# @opengui/backend

Networked **OpenGUI Backend**: embeds `@opengui/runtime`, adds HTTP/WebSocket/SSE (and Desktop IPC), queued prompts, arbitration, Backend persistence.

**Status:** Product HTTP routes live here (`registerProductApiRoutes`). Process entry remains `server/web-server.ts` (SSE, RPC, FS, static hosting, auth middleware). Further extraction: [`docs/plans/runtime-backend-sdk-split.md`](../../docs/plans/runtime-backend-sdk-split.md) Phase 4.

```ts
import { registerProductApiRoutes } from "@opengui/backend";

registerProductApiRoutes(app, apiRouteDeps);
```
