import type { Hono } from "hono";
import { homedir } from "node:os";
import { findFilesInDirectory } from "../../../../server/services/file-search.ts";
import { jsonError } from "../http/json.ts";
import type { BackendHostEnv } from "../host/env.ts";
import type { OpenGuiHost } from "../host/opengui-host.ts";

export type HostTransportRouteDeps = {
  env: Pick<BackendHostEnv, "allowedRoots" | "serverMode" | "servesFrontend" | "authToken">;
  ready: Promise<void>;
  getHost: () => Promise<OpenGuiHost>;
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>;
};

export function registerHostTransportRoutes(app: Hono, deps: HostTransportRouteDeps) {
  app.get("/api/capabilities", () =>
    Response.json({
      ok: true,
      value: {
        protocolVersion: 1,
        host: true,
        firstPartyHarness: true,
        models: true,
        sessions: true,
        followUps: true,
        uploads: true,
        fileSearch: true,
        git: false,
        permissions: false,
        questions: false,
      },
    }),
  );

  app.get("/api/version", () =>
    Response.json({
      ok: true,
      value: {
        protocolVersion: 1,
        appVersion: process.env.npm_package_version || "0.0.0",
      },
    }),
  );

  app.post("/api/rpc", async (c) => {
    await deps.ready;
    try {
      const body = (await c.req.raw.json()) as { channel?: unknown; args?: unknown };
      const channel = typeof body.channel === "string" ? body.channel : "";
      const args = Array.isArray(body.args) ? body.args : [];
      if (
        channel === "settings:set" ||
        channel === "settings:remove" ||
        channel === "settings:merge"
      ) {
        return Response.json({ ok: true, value: true });
      }
      if (channel === "platform:homeDir") {
        return Response.json({ ok: true, value: homedir() });
      }
      if (channel === "files:find") {
        const directory = await deps.resolveSafeDirectory(
          typeof args[0] === "string" ? args[0] : "",
        );
        const query = typeof args[1] === "string" ? args[1] : "";
        return Response.json({
          ok: true,
          value: await findFilesInDirectory(directory, query),
        });
      }
      throw new Error(`RPC channel not available: ${channel || "<missing>"}`);
    } catch (error) {
      return jsonError(error);
    }
  });
}
