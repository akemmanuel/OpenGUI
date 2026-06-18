import type { Hono } from "hono";
import { getBackendCapabilities } from "../../../server/services/capabilities.ts";
import type { ApiRouteDeps } from "./http/types.ts";
import { handleDirectoryRequest } from "./routes/directory.ts";
import { handleHarnessRequest } from "./routes/harness.ts";
import { handlePermissionRequest } from "./routes/permission.ts";
import { handleQuestionRequest } from "./routes/question.ts";
import { handleSessionRequest } from "./routes/session.ts";

const apiHandlers = [
  handleDirectoryRequest,
  handleSessionRequest,
  handlePermissionRequest,
  handleQuestionRequest,
  handleHarnessRequest,
] as const;

/** Registers Session list read, Queue, directory, harness, permission, and question routes on an existing Hono app. */
export function registerProductApiRoutes(app: Hono, deps: ApiRouteDeps) {
  async function dispatchApi(request: Request) {
    for (const handler of apiHandlers) {
      const response = await handler(request, deps);
      if (response) return response;
    }
    return new Response("Not found", { status: 404 });
  }

  app.get("/api/capabilities", () => Response.json({ ok: true, value: getBackendCapabilities() }));
  app.get("/api/version", () =>
    Response.json({
      ok: true,
      value: {
        protocolVersion: 1,
        appVersion: process.env.npm_package_version || "0.0.0",
      },
    }),
  );

  const paths = [
    "/api/directories/*",
    "/api/queues",
    "/api/sessions",
    "/api/sessions/*",
    "/api/permissions/*",
    "/api/questions/*",
    "/api/harnesses",
  ] as const;
  for (const path of paths) {
    app.all(path, (c) => dispatchApi(c.req.raw));
  }
}
