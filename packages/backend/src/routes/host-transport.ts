import { homedir } from "node:os";
import type { Hono } from "hono";
import { findFilesInDirectory } from "../../../../server/services/index.ts";
import type { InProcessIpcMain, InProcessIpcSender } from "@opengui/runtime";
import { jsonError } from "../http/json.ts";
import { createSseResponse } from "../transport/sse.ts";
import type { BridgeBroadcastState } from "../transport/bridge-broadcast.ts";
import type { BackendServiceContext } from "../../../../server/services/index.ts";
import type { BackendHostEnv } from "../host/env.ts";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function rpcErrorCode(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("not available") || message.includes("not found"))
    return "BACKEND_UNAVAILABLE";
  if (message.includes("auth") || message.includes("login")) return "AUTH_REQUIRED";
  if (message.includes("permission") || message.includes("denied")) return "PERMISSION_DENIED";
  if (message.includes("timeout") || message.includes("timed out")) return "BACKEND_TIMEOUT";
  return "UNKNOWN";
}

function normalizeRpcArgs(channel: string, args: unknown[], allowedRoots: string[]) {
  if (
    (channel === "opencode:providers" ||
      channel === "opencode:agents" ||
      channel === "opencode:commands" ||
      channel === "opencode:provider:list" ||
      channel === "opencode:provider:auth-methods") &&
    (typeof args[0] !== "string" || !args[0].trim())
  ) {
    return [allowedRoots[0] || homedir(), args[1], ...args.slice(2)];
  }
  return args;
}

function logRpc(channel: string, startedAt: number, ok: boolean, error?: unknown) {
  const durationMs = Date.now() - startedAt;
  const status = ok ? "ok=true" : `ok=false code=${rpcErrorCode(error)}`;
  console.info(`[rpc] channel=${channel || "<missing>"} duration=${durationMs}ms ${status}`);
}

export type HostTransportRouteDeps = {
  env: Pick<BackendHostEnv, "allowedRoots" | "serverMode" | "servesFrontend" | "authToken">;
  servicesReady: Promise<BackendServiceContext>;
  ready: Promise<void>;
  ipcMain: InProcessIpcMain;
  sender: InProcessIpcSender;
  bridge: BridgeBroadcastState;
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>;
};

export function registerHostTransportRoutes(app: Hono, deps: HostTransportRouteDeps) {
  app.get("/api/events", (c) =>
    createSseResponse(
      c.req.raw.signal,
      (client) => {
        deps.bridge.rawClients.add(client);
      },
      (client) => {
        deps.bridge.rawClients.delete(client);
      },
    ),
  );

  app.get("/api/events/v2", async (c) =>
    createSseResponse(
      c.req.raw.signal,
      async (client) => {
        deps.bridge.canonicalClients.add(client);
        const services = await deps.servicesReady;
        const cursor =
          c.req.query("cursor") || c.req.header("last-event-id") || c.req.header("Last-Event-ID");
        if (cursor) {
          for (const event of services.events.listEventsAfter(cursor)) {
            await client.send(JSON.stringify(event), event.id);
          }
        }
      },
      (client) => {
        deps.bridge.canonicalClients.delete(client);
      },
    ),
  );

  app.post("/api/rpc", async (c) => {
    const startedAt = Date.now();
    let channel = "";
    await deps.ready;
    try {
      const body = (await c.req.raw.json()) as { channel?: unknown; args?: unknown };
      channel = typeof body.channel === "string" ? body.channel : "";
      const rawArgs = Array.isArray(body.args) ? body.args : [];
      const args = normalizeRpcArgs(channel, rawArgs, deps.env.allowedRoots);
      const value =
        channel === "files:find"
          ? await findFilesInDirectory(
              await deps.resolveSafeDirectory(typeof args[0] === "string" ? args[0] : ""),
              typeof args[1] === "string" ? args[1] : "",
            )
          : await deps.ipcMain.invoke(channel, { sender: deps.sender }, args);
      logRpc(channel, startedAt, true);
      return Response.json({ ok: true, value });
    } catch (error) {
      logRpc(channel, startedAt, false, error);
      return jsonError(error);
    }
  });

  app.get("/api/health", () =>
    Response.json({
      ok: true,
      mode: deps.env.serverMode,
      servesFrontend: deps.env.servesFrontend,
      allowedRoots: deps.env.allowedRoots,
      authRequired: Boolean(deps.env.authToken),
    }),
  );
}
