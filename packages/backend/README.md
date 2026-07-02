# @opengui/backend

Networked **OpenGUI Backend**: embeds `@opengui/runtime`, adds HTTP/WebSocket/SSE (and Desktop IPC), queued prompts, arbitration, Backend persistence.

**Status:** Host wiring lives here (`createBackendHost`: CORS/auth, SSE, RPC, FS, static, product API). `server/web-server.ts` only calls `serve()` on the Hono app. Service implementations remain in `server/services/*` until a later pass.

```ts
import { createBackendHost } from "@opengui/backend";

const { app, env } = createBackendHost();
// bind with @hono/node-server or app.fetch in tests
```
