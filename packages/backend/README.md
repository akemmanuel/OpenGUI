# @opengui/backend

Networked **OpenGUI Host** package: owns one first-party `@opengui/harness`, durable Sessions,
authentication/authorization, follow-up arbitration, HTTP/events, and Desktop private transport.

`createBackendHost` wires CORS/auth, event streaming, filesystem routes, static assets, and the
product API. `server/web-server.ts` is the deployment entry point that serves the Hono app.

```ts
import { createBackendHost } from "@opengui/backend";

const { app, env } = createBackendHost();
// bind with @hono/node-server or app.fetch in tests
```
