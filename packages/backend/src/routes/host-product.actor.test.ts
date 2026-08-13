import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { PromptInput } from "@opengui/harness";
import type { OpenGuiHost } from "../host/opengui-host.ts";
import { HostSessionNotFoundError } from "../host/opengui-host.ts";
import type { BackendRequestEnv } from "../http/request-context.ts";
import type { Actor } from "../identity/types.ts";
import { registerHostProductRoutes } from "./host-product.ts";

describe("Host product actor attribution", () => {
  test.each([
    { type: "user", id: "member", displayName: "Member", role: "member" },
    { type: "user", id: "viewer", displayName: "Viewer", role: "viewer" },
    { type: "api_key", id: "key", displayName: "API key", role: "admin" },
  ] as Actor[])("denies Skills management to $type/$role actors", async (actor) => {
    const installSkill = vi.fn();
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/host/*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    registerHostProductRoutes(app, {
      getHost: async () => ({ installSkill }) as unknown as OpenGuiHost,
      resolveSafeDirectory: async (path) => path ?? "/tmp",
    });

    const response = await app.request("http://localhost/api/host/skills/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "github:acme/skills/demo@main",
        directory: "/tmp/project",
        scope: "project",
        requestId: "request_denied_1",
      }),
    });

    expect(response.status).toBe(403);
    expect(installSkill).not.toHaveBeenCalled();
  });

  test("normalizes a multi-model backend and preserves route and capability options", async () => {
    const upsertModelConnection = vi.fn(async (connection) => connection);
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/host/*", async (c, next) => {
      c.set("actor", {
        type: "local",
        id: "desktop-local",
        displayName: "Local user",
        role: "owner",
      });
      await next();
    });
    registerHostProductRoutes(app, {
      getHost: async () => ({ upsertModelConnection }) as unknown as OpenGuiHost,
      resolveSafeDirectory: async (path) => path ?? "/tmp",
    });

    const response = await app.request("http://localhost/api/host/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "gateway",
        label: "Company gateway",
        baseUrl: "https://models.example/v1",
        modelIds: [" alpha ", "beta"],
        defaultModelId: "beta",
        modelRoutes: { alpha: "responses", beta: "anthropic-messages" },
        modelCapabilities: {
          alpha: {
            displayName: "Alpha",
            context: 128000,
            reasoning: true,
            reasoningEfforts: [],
          },
          beta: { reasoning: false },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(upsertModelConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        modelIds: ["alpha", "beta"],
        defaultModelId: "beta",
        modelRoutes: { alpha: "responses", beta: "anthropic-messages" },
        modelCapabilities: {
          alpha: expect.objectContaining({
            displayName: "Alpha",
            context: 128000,
            reasoning: true,
          }),
          beta: expect.objectContaining({ reasoning: false }),
        },
      }),
    );
    expect(upsertModelConnection.mock.calls[0]?.[0].modelCapabilities.alpha).not.toHaveProperty(
      "reasoningEfforts",
    );
  });

  test("rejects duplicate model IDs in a custom backend", async () => {
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/host/*", async (c, next) => {
      c.set("actor", {
        type: "local",
        id: "desktop-local",
        displayName: "Local user",
        role: "owner",
      });
      await next();
    });
    registerHostProductRoutes(app, {
      getHost: async () => ({ upsertModelConnection: vi.fn() }) as unknown as OpenGuiHost,
      resolveSafeDirectory: async (path) => path ?? "/tmp",
    });
    const response = await app.request("http://localhost/api/host/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://models.example", modelIds: ["same", " same "] }),
    });
    expect(response.status).toBe(400);
  });

  test.each([
    { type: "user", id: "user-1", displayName: "Ada", role: "member" },
    { type: "api_key", id: "key-1", displayName: "CI key", role: "owner" },
    { type: "local", id: "desktop-local", displayName: "Local user", role: "owner" },
  ] satisfies Actor[])(
    "stamps trusted $type context and ignores request actor JSON",
    async (actor) => {
      const prompt = vi.fn(async (_sessionId: string, input: PromptInput) => ({
        mode: "run" as const,
        input,
      }));
      const app = new Hono<BackendRequestEnv>();
      app.use("/api/host/*", async (c, next) => {
        c.set("actor", actor);
        await next();
      });
      registerHostProductRoutes(app, {
        getHost: async () => ({ prompt }) as unknown as OpenGuiHost,
        resolveSafeDirectory: async (path) => path ?? "/tmp",
      });

      const response = await app.request("http://localhost/api/host/sessions/session-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Ship it",
          actor: { type: "user", id: "spoofed", displayName: "Mallory", role: "owner" },
        }),
      });

      expect(response.status).toBe(200);
      expect(prompt).toHaveBeenCalledWith("session-1", {
        text: "Ship it",
        actor: { type: actor.type, id: actor.id, displayName: actor.displayName },
      });
    },
  );

  test.each([
    { requested: [] as string[], expected: [] as string[] },
    { requested: ["enabled", " enabled ", "", 42], expected: ["enabled", "enabled"] },
  ])(
    "forwards the exact skills allowlist through the HTTP route",
    async ({ requested, expected }) => {
      const prompt = vi.fn(async () => ({ mode: "run" as const, startedEntries: [] }));
      const app = new Hono<BackendRequestEnv>();
      app.use("/api/host/*", async (c, next) => {
        c.set("actor", {
          type: "local",
          id: "desktop-local",
          displayName: "Local user",
          role: "owner",
        });
        await next();
      });
      registerHostProductRoutes(app, {
        getHost: async () => ({ prompt }) as unknown as OpenGuiHost,
        resolveSafeDirectory: async (path) => path ?? "/tmp",
      });

      const response = await app.request("http://localhost/api/host/sessions/session-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Check catalog", skills: requested }),
      });

      expect(response.status).toBe(200);
      expect(prompt).toHaveBeenCalledWith("session-1", {
        text: "Check catalog",
        skills: expected,
        actor: { type: "local", id: "desktop-local", displayName: "Local user" },
      });
    },
  );

  test("requires restricted SSE subscriptions to name one authorized Session", async () => {
    const actor: Actor = {
      type: "user",
      id: "member-1",
      displayName: "Member",
      role: "member",
    };
    const authorizeSession = vi.fn(async (sessionId: string) => {
      if (sessionId !== "allowed") throw new HostSessionNotFoundError();
      return { id: sessionId };
    });
    const subscribe = vi.fn(async (_actor: unknown, sessionId: string | undefined) => {
      await authorizeSession(sessionId ?? "");
      return () => undefined;
    });
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/host/*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    registerHostProductRoutes(app, {
      getHost: async () =>
        ({
          requiresScopedEvents: async () => true,
          authorizeSession,
          subscribe,
        }) as unknown as OpenGuiHost,
      resolveSafeDirectory: async (path) => path ?? "/tmp",
    });

    expect((await app.request("http://localhost/api/host/events")).status).toBe(403);
    expect((await app.request("http://localhost/api/host/events?sessionId=denied")).status).toBe(
      404,
    );

    const controller = new AbortController();
    const response = await app.request("http://localhost/api/host/events?sessionId=allowed", {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(subscribe).toHaveBeenCalledWith(
      { type: "user", id: "member-1", displayName: "Member" },
      "allowed",
      expect.any(Function),
    );
    controller.abort();
  });

  test("attributes edited follow-up content to the authenticated editor", async () => {
    const editor: Actor = {
      type: "user",
      id: "editor",
      displayName: "Editor",
      role: "member",
    };
    const updateFollowUp = vi.fn(async () => []);
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/host/*", async (c, next) => {
      c.set("actor", editor);
      await next();
    });
    registerHostProductRoutes(app, {
      getHost: async () => ({ updateFollowUp }) as unknown as OpenGuiHost,
      resolveSafeDirectory: async (path) => path ?? "/tmp",
    });

    const response = await app.request(
      "http://localhost/api/host/sessions/session-1/follow-ups/follow-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Edited by B",
          actor: { type: "user", id: "author-a", displayName: "Author A" },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(updateFollowUp).toHaveBeenCalledWith("session-1", "follow-1", {
      text: "Edited by B",
      actor: { type: "user", id: "editor", displayName: "Editor" },
    });
  });

  test.each([
    { type: "user", id: "member", displayName: "Member", role: "member" },
    { type: "user", id: "viewer", displayName: "Viewer", role: "viewer" },
    { type: "api_key", id: "key", displayName: "API key", role: "admin" },
  ] as Actor[])("denies custom instruction edits to $type/$role actors", async (actor) => {
    const setCustomInstructions = vi.fn();
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/host/*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    registerHostProductRoutes(app, {
      getHost: async () => ({ setCustomInstructions }) as unknown as OpenGuiHost,
      resolveSafeDirectory: async (path) => path ?? "/tmp",
    });

    const response = await app.request("http://localhost/api/host/custom-instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Always reply in Spanish." }),
    });

    expect(response.status).toBe(403);
    expect(setCustomInstructions).not.toHaveBeenCalled();
  });

  test("lets a Host administrator read and save custom instructions", async () => {
    const getCustomInstructions = vi.fn(() => "Always reply in Spanish.");
    const setCustomInstructions = vi.fn(async (text: string) => text.trim());
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/host/*", async (c, next) => {
      c.set("actor", {
        type: "user",
        id: "owner",
        displayName: "Owner",
        role: "owner",
      });
      await next();
    });
    registerHostProductRoutes(app, {
      getHost: async () =>
        ({ getCustomInstructions, setCustomInstructions }) as unknown as OpenGuiHost,
      resolveSafeDirectory: async (path) => path ?? "/tmp",
    });

    const read = await app.request("http://localhost/api/host/custom-instructions");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      ok: true,
      value: { text: "Always reply in Spanish." },
    });

    const write = await app.request("http://localhost/api/host/custom-instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: " Prefer British spelling. " }),
    });
    expect(write.status).toBe(200);
    expect(setCustomInstructions).toHaveBeenCalledWith(" Prefer British spelling. ");
    expect(await write.json()).toEqual({
      ok: true,
      value: { text: "Prefer British spelling." },
    });
  });
});
