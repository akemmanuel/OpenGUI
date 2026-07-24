import type { BackendApp } from "../http/request-context.ts";
import { homedir } from "node:os";
import { findFilesInDirectory } from "../../../../server/services/file-search.ts";
import { jsonError } from "../http/json.ts";
import type { BackendHostEnv } from "../host/env.ts";
import type { OpenGuiHost } from "../host/opengui-host.ts";
import { durableActor } from "../identity/types.ts";
import { HostPathAuthorizer, PathAuthorizationError } from "../path-policy/enforcement.ts";

export type HostTransportRouteDeps = {
  env: Pick<BackendHostEnv, "allowedRoots" | "serverMode" | "servesFrontend" | "authToken">;
  ready: Promise<void>;
  getHost: () => Promise<OpenGuiHost>;
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>;
  pathAuthorizer: HostPathAuthorizer;
  pathGrantsEnforced?: boolean;
};

export function registerHostTransportRoutes(app: BackendApp, deps: HostTransportRouteDeps) {
  app.get("/api/capabilities", async (c) => {
    const policy = await deps.pathAuthorizer.policy(durableActor(c.get("actor")));
    const uploads =
      policy?.restricted !== true ||
      (
        await Promise.all(
          (policy?.grants ?? [])
            .filter((grant) => grant.access === "write")
            .map((grant) => policy!.authorizePath(grant.root, "write")),
        )
      ).some((decision) => decision.allowed);
    return Response.json({
      ok: true,
      value: {
        protocolVersion: 1,
        host: true,
        firstPartyHarness: true,
        models: true,
        sessions: true,
        followUps: true,
        uploads,
        fileSearch: true,
        git: false,
        permissions: deps.pathGrantsEnforced === true,
        questions: false,
      },
    });
  });

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
        const directory = await deps.pathAuthorizer.authorizePath(
          durableActor(c.get("actor")),
          homedir(),
          "read",
        );
        return Response.json({ ok: true, value: directory });
      }
      if (channel === "files:find") {
        const requested = typeof args[0] === "string" ? args[0] : "";
        const authorized = await deps.pathAuthorizer.authorizePath(
          durableActor(c.get("actor")),
          requested,
          "read",
        );
        const directory = await deps.resolveSafeDirectory(authorized);
        const query = typeof args[1] === "string" ? args[1] : "";
        return Response.json({
          ok: true,
          value: await findFilesInDirectory(directory, query),
        });
      }
      throw new Error(`RPC channel not available: ${channel || "<missing>"}`);
    } catch (error) {
      return jsonError(error, error instanceof PathAuthorizationError ? 403 : 500);
    }
  });
}
