import { Hono } from "hono";
import { registerShellIpcHandlers } from "../../../server/shell-ipc-handlers.ts";
import {
  InProcessIpcMain,
  InProcessIpcSender,
  resolveSafeDirectory as resolveSafeDirectoryInRoots,
} from "@opengui/runtime";
import type { BackendServiceContext } from "../../../server/services/index.ts";
import { registerProductApiRoutes } from "./create-api-app.ts";
import { createApiRouteDeps } from "./host/api-route-deps.ts";
import { createBackendServiceContext } from "./host/bootstrap.ts";
import { readBackendHostEnv, type BackendHostEnv } from "./host/env.ts";
import { createCorsAuth } from "./http/cors-auth.ts";
import { registerFsRoutes } from "./routes/fs.ts";
import { registerHostTransportRoutes } from "./routes/host-transport.ts";
import { createBridgeBroadcast } from "./transport/bridge-broadcast.ts";
import { serveBuiltFile, serveDevIndex } from "./transport/static-host.ts";

export type CreateBackendHostOptions = {
  env?: BackendHostEnv;
};

export type BackendHost = {
  env: BackendHostEnv;
  app: Hono;
  servicesReady: Promise<BackendServiceContext>;
  ready: Promise<void>;
  ipcMain: InProcessIpcMain;
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

  const ipcMain = new InProcessIpcMain();
  const broadcastHolder = {
    fn: (_channel: string, _data: unknown) => {},
  };
  const relayBroadcast = (channel: string, data: unknown) => broadcastHolder.fn(channel, data);
  const sender = new InProcessIpcSender(relayBroadcast);
  const servicesReady = createBackendServiceContext(
    ipcMain,
    sender,
    relayBroadcast,
    resolveSafeDirectory,
  );

  const bridge = createBridgeBroadcast({
    servicesReady,
    resolveSafeDirectory,
    sender,
  });
  broadcastHolder.fn = bridge.broadcast;

  const ready = servicesReady.then(async (services) => {
    bridge.attachCanonicalEventFanout(services);
    registerShellIpcHandlers({ ipcMain, broadcast: bridge.broadcast, services });
  });

  const apiRouteDeps = createApiRouteDeps({
    getServices: () => servicesReady,
    resolveSafeDirectory,
  });

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
    if (c.req.path === "/api/health") {
      await next();
      return;
    }

    if (!corsAuth.isAuthorizedRequest(c.req.raw)) {
      c.res = corsAuth.unauthorizedResponse();
      return;
    }

    await next();
  });

  registerProductApiRoutes(app, apiRouteDeps);

  registerHostTransportRoutes(app, {
    env,
    servicesReady,
    ready,
    ipcMain,
    sender,
    bridge,
    resolveSafeDirectory,
  });

  registerFsRoutes(app, {
    env,
    resolveSafeDirectory,
    resolveHarnessDirectoryForSessions: apiRouteDeps.resolveHarnessDirectoryForSessions,
  });

  app.all("/api/*", () => new Response("Not found", { status: 404 }));

  app.all("*", async (c) => {
    if (!env.servesFrontend) {
      return Response.json(
        { ok: false, error: "OpenGUI Backend is running in API-only mode" },
        { status: 404 },
      );
    }
    if (env.isProduction) return await serveBuiltFile(c.req.raw);
    return await serveDevIndex();
  });

  return { env, app, servicesReady, ready, ipcMain };
}
