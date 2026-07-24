import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { createHostContext } from "./host/bootstrap.ts";
import { readBackendHostEnv, type BackendHostEnv } from "./host/env.ts";
import { resolveSafeDirectory as resolveSafeDirectoryInRoots } from "./host/path-safety.ts";
import { createCorsAuth } from "./http/cors-auth.ts";
import { createAuthorizer } from "./http/authorize.ts";
import type { BackendApp, BackendRequestEnv } from "./http/request-context.ts";
import { IdentityService } from "./identity/identity.ts";
import { registerFsRoutes } from "./routes/fs.ts";
import { registerHostProductRoutes } from "./routes/host-product.ts";
import { registerHostTransportRoutes } from "./routes/host-transport.ts";
import { registerIdentityRoutes } from "./routes/identity.ts";
import { serveBuiltFile, serveDevIndex } from "./transport/static-host.ts";
import type { OpenGuiHost, SessionAccessGate } from "./host/opengui-host.ts";
import {
  createEnforcedPolicyResolver,
  createLocalPolicyResolver,
  HostPathAuthorizer,
} from "./path-policy/enforcement.ts";
import type { DurableActor } from "@opengui/harness";
import type { SessionAccessAction } from "./identity/identity.ts";

export type CreateBackendHostOptions = {
  env?: BackendHostEnv;
  identityDatabase?: DatabaseSync;
  identityDatabasePath?: string;
  identitySecret?: string;
  identityBaseURL?: string;
};

export type BackendHost = {
  env: BackendHostEnv;
  app: BackendApp;
  hostReady: Promise<OpenGuiHost>;
  ready: Promise<void>;
  identity?: IdentityService;
};

export function createBackendHost(options: CreateBackendHostOptions = {}): BackendHost {
  const env = options.env ?? readBackendHostEnv();
  const corsAuth = createCorsAuth({
    authToken: env.authToken,
    allowedCorsOrigin: env.allowedCorsOrigin,
  });
  const identity =
    env.identityMode === "remote"
      ? new IdentityService({
          database: options.identityDatabase,
          databasePath: options.identityDatabasePath,
          secret: options.identitySecret,
          baseURL: options.identityBaseURL,
          trustedOrigins: [env.allowedCorsOrigin],
          pathGrantsMode: env.pathGrantsMode,
          allowedRoots: env.allowedRoots,
        })
      : undefined;
  const authorizer = createAuthorizer({
    mode: env.identityMode,
    identity,
    legacyAuthToken: env.authToken,
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

  const resolveExecutionPolicy =
    env.pathGrantsMode !== "enforced"
      ? undefined
      : identity
        ? createEnforcedPolicyResolver(identity)
        : createLocalPolicyResolver(env.allowedRoots);
  const pathAuthorizer = new HostPathAuthorizer(resolveExecutionPolicy);
  const sessionAccess: SessionAccessGate | undefined = identity
    ? {
        async onCreated(sessionId: string, actor: DurableActor) {
          const resolved = await identity.resolveDurableActor(actor);
          if (resolved) await identity.recordSessionOwner(sessionId, resolved);
        },
        async onDeleted(sessionId: string) {
          await identity.deleteSessionAccess(sessionId);
        },
        async authorize(
          sessionId: string,
          actor: DurableActor | undefined,
          action: SessionAccessAction,
        ) {
          if (!actor) return;
          const resolved = await identity.resolveDurableActor(actor);
          if (!resolved) throw new Error("Session not found");
          await identity.authorizeSessionAction(sessionId, resolved, action);
        },
        async filterList(sessionIds: string[], actor: DurableActor | undefined) {
          if (!actor) return sessionIds;
          const resolved = await identity.resolveDurableActor(actor);
          if (!resolved) return [];
          return await identity.filterVisibleSessionIds(sessionIds, resolved);
        },
      }
    : undefined;
  const hostReady = createHostContext({ resolveExecutionPolicy, sessionAccess }).then(
    (context) => context.host,
  );
  const ready = Promise.all([hostReady, identity?.ready]).then(() => undefined);

  const app = new Hono<BackendRequestEnv>();

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      c.res = corsAuth.optionsResponse();
      return;
    }
    await next();
    c.res = corsAuth.withCors(c.res ?? new Response("Not found", { status: 404 }));
  });

  app.use("/api/*", async (c, next) => {
    if (
      c.req.path === "/api/health" ||
      c.req.path === "/api/host/health" ||
      c.req.path === "/api/identity/setup" ||
      c.req.path === "/api/identity/login" ||
      c.req.path === "/api/identity/register" ||
      c.req.path === "/api/identity/policy" ||
      (c.req.path === "/api/identity/invites/accept" && c.req.method === "POST") ||
      (c.req.path === "/api/identity/session-view-links/resolve" && c.req.method === "GET") ||
      c.req.path === "/api/auth/login"
    ) {
      await next();
      return;
    }
    const actor = await authorizer.resolveActor(c.req.raw);
    if (!actor) {
      c.res = corsAuth.unauthorizedResponse();
      return;
    }
    c.set("actor", actor);
    const ownerOnly =
      c.req.path.startsWith("/api/host/auth/") ||
      (c.req.path.startsWith("/api/host/models") &&
        c.req.method !== "GET" &&
        actor.type !== "user");
    if (ownerOnly && actor.role !== "owner") {
      c.res = Response.json(
        { ok: false, error: "Owner access required", code: "FORBIDDEN" },
        { status: 403 },
      );
      return;
    }
    await next();
  });

  registerHostProductRoutes(app, {
    getHost: () => hostReady,
    resolveSafeDirectory,
    getIdentityState: async () =>
      env.identityMode === "desktop-local" ? "local" : await identity!.state(),
    authRequired: env.identityMode === "remote",
    pathAuthorizer,
    identity,
  });

  registerIdentityRoutes(app, {
    mode: env.identityMode,
    identity,
    getActor: authorizer.resolveActor,
    readSessionForViewLink: async (sessionId) =>
      (await hostReady).readSessionForViewLink(sessionId),
  });

  registerHostTransportRoutes(app, {
    env,
    ready,
    getHost: () => hostReady,
    resolveSafeDirectory,
    pathAuthorizer,
    pathGrantsEnforced: env.pathGrantsMode === "enforced",
  });

  registerFsRoutes(app, {
    env,
    resolveSafeDirectory,
    pathAuthorizer,
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

  return { env, app, hostReady, ready, identity };
}
