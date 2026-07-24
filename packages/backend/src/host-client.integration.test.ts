import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createHostClient } from "../../../src/protocol/host-client.ts";
import { OpenGuiHost } from "./host/opengui-host.ts";
import { resolveSafeDirectory } from "./host/path-safety.ts";
import type { BackendRequestEnv } from "./http/request-context.ts";
import type { Actor } from "./identity/types.ts";
import { HostPathAuthorizer } from "./path-policy/enforcement.ts";
import { registerHostProductRoutes } from "./routes/host-product.ts";
import { registerHostTransportRoutes } from "./routes/host-transport.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("createHostClient with an in-process Hono Host", () => {
  test("round-trips Project and Session behavior through the real HTTP contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-client-host-contract-"));
    const dataDirectory = join(root, "data");
    const projectDirectory = join(root, "project & notes");
    await Promise.all([mkdir(dataDirectory), mkdir(projectDirectory)]);
    const host = new OpenGuiHost(dataDirectory);
    await host.start();
    cleanups.push(async () => {
      await host.close();
      await rm(root, { recursive: true });
    });
    await host.upsertModelConnection({
      id: "offline-test",
      label: "Offline test",
      baseUrl: "http://127.0.0.1/unused",
      modelIds: ["model-a"],
    });

    const actor: Actor = {
      type: "local",
      id: "desktop-local",
      displayName: "Local user",
      role: "owner",
    };
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/*", async (context, next) => {
      context.set("actor", actor);
      await next();
    });
    const pathAuthorizer = new HostPathAuthorizer();
    registerHostProductRoutes(app, {
      getHost: async () => host,
      resolveSafeDirectory: (path) => resolveSafeDirectory(path, [root]),
      pathAuthorizer,
    });
    registerHostTransportRoutes(app, {
      env: {
        allowedRoots: [root],
        serverMode: "api-only",
        servesFrontend: false,
        authToken: "",
      },
      ready: Promise.resolve(),
      getHost: async () => host,
      resolveSafeDirectory: (path) => resolveSafeDirectory(path, [root]),
      pathAuthorizer,
    });
    const client = createHostClient({
      baseUrl: "http://in-process.test/",
      fetchImpl: async (url, init) => await app.request(url, init),
    });

    expect(await client.health()).toMatchObject({ ok: true });
    expect(await client.registerProject(projectDirectory)).toEqual({
      directory: projectDirectory,
      name: "project & notes",
    });
    const created = await client.createSession({
      directory: projectDirectory,
      title: "Contract session",
      model: { connectionId: "offline-test", modelId: "model-a" },
      reasoning: "low",
    });
    expect(created).toMatchObject({ title: "Contract session", reasoning: "low" });

    expect(
      (await client.listSessions(projectDirectory)).map((session: { id: string }) => session.id),
    ).toEqual([created.id]);
    expect((await client.renameSession(created.id, "Renamed over HTTP")).title).toBe(
      "Renamed over HTTP",
    );
    expect((await client.setReasoning(created.id, "high")).reasoning).toBe("high");
    expect(
      (
        await client.setModel(created.id, {
          connectionId: "offline-test",
          modelId: "model-a",
        })
      ).model,
    ).toEqual({ connectionId: "offline-test", modelId: "model-a" });
    expect(
      (await client.readSession(created.id)).entries.map((entry: { kind: string }) => entry.kind),
    ).toEqual([
      "session_created",
      "model_changed",
      "reasoning_changed",
      "session_renamed",
      "reasoning_changed",
      "model_changed",
    ]);

    await client.deleteSession(created.id);
    await expect(client.readSession(created.id)).rejects.toThrow("Session not found");
    await client.unregisterProject(projectDirectory);
    expect(await client.listProjects()).toEqual([]);
  });
});
