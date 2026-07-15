import { Hono } from "hono";
import { createHostContext } from "./host/bootstrap.ts";
import { readBackendHostEnv, type BackendHostEnv } from "./host/env.ts";
import { resolveSafeDirectory as resolveSafeDirectoryInRoots } from "./host/path-safety.ts";
import { createCorsAuth } from "./http/cors-auth.ts";
import { registerFsRoutes } from "./routes/fs.ts";
import { registerHostProductRoutes } from "./routes/host-product.ts";
import { registerHostTransportRoutes } from "./routes/host-transport.ts";
import { serveBuiltFile, serveDevIndex } from "./transport/static-host.ts";
import type { OpenGuiHost } from "./host/opengui-host.ts";

export type CreateBackendHostOptions = {
  env?: BackendHostEnv;
};

export type BackendHost = {
  env: BackendHostEnv;
  app: Hono;
  hostReady: Promise<OpenGuiHost>;
  ready: Promise<void>;
};

export function createBackendHost(options: CreateBackendHostOptions = {}): BackendHost {
  const env = options.env ?? readBackendHostEnv();
  const corsAuth = createCorsAuth({
    authToken: env.authToken,
    allowedCorsOrigin: env.allowedCorsOrigin,
  });

  async function resolveSafeDirectory(inputPath: string | null) {
    try {
      return await resolveSafeDirectoryInRoots(inputPath, env.allowedRoots);
    } catch (error) {
      if (error instanceof Error && error.message === "Path outside allowedRoots") {
        throw new Error("Path outside OPENGUI_ALLOWED_ROOTS");
      }
      throw error;
    }
  }

  const hostReady = createHostContext().then((context) => context.host);
  const ready = hostReady.then(() => undefined);

  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      c.res = corsAuth.optionsResponse();
      return;
    }
    await next();
    c.res = corsAuth.withCors(c.res ?? new Response("Not found", { status: 404 }));
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health" || c.req.path === "/api/host/health") {
      await next();
      return;
    }
    if (!corsAuth.isAuthorizedRequest(c.req.raw)) {
      c.res = corsAuth.unauthorizedResponse();
      return;
    }
    await next();
  });

  registerHostProductRoutes(app, {
    getHost: () => hostReady,
    resolveSafeDirectory,
    authRequired: Boolean(env.authToken),
  });

  registerHostTransportRoutes(app, {
    env,
    ready,
    getHost: () => hostReady,
    resolveSafeDirectory,
  });

  registerFsRoutes(app, {
    env,
    resolveSafeDirectory,
  });

  app.all("/api/*", () => new Response("Not found", { status: 404 }));

  app.all("*", async (c) => {
    if (!env.servesFrontend) {
      return Response.json(
        { ok: false, error: "OpenGUI Host is running in API-only mode" },
        { status: 404 },
      );
    }
    if (env.isProduction) return await serveBuiltFile(c.req.raw);
    return await serveDevIndex();
  });

  return { env, app, hostReady, ready };
}
