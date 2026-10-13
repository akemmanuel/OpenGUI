import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { PromptInput } from "@opengui/harness";
import type { OpenGuiHost } from "../host/opengui-host.ts";
import { HostSessionNotFoundError } from "../host/opengui-host.ts";
import type { BackendRequestEnv } from "../http/request-context.ts";
import type { Actor } from "../identity/types.ts";
import { IdentityError, type IdentityService } from "../identity/identity.ts";
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

  test("allows ACL-filtered global SSE while rejecting unauthorized scoped Sessions", async () => {
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
      if (sessionId) await authorizeSession(sessionId);
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

    const globalController = new AbortController();
    const globalResponse = await app.request("http://localhost/api/host/events", {
      signal: globalController.signal,
    });
    expect(globalResponse.status).toBe(200);
    globalController.abort();

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

describe("personal subscription authorization", () => {
  const member: Actor = {
    type: "user",
    id: "member-1",
    displayName: "Member",
    role: "member",
  };

  function subscriptionApp(input: {
    actor?: Actor;
    authorize?: () => Promise<void>;
    status?: ReturnType<typeof vi.fn>;
    begin?: ReturnType<typeof vi.fn>;
    disconnect?: ReturnType<typeof vi.fn>;
    poll?: ReturnType<typeof vi.fn>;
    personalConnection?: ReturnType<typeof vi.fn>;
    resolveActor?: ReturnType<typeof vi.fn>;
    recordConnection?: ReturnType<typeof vi.fn>;
    subscriptionBegin?: ReturnType<typeof vi.fn>;
    subscriptionPoll?: ReturnType<typeof vi.fn>;
  }) {
    const actor = input.actor ?? member;
    const status = input.status ?? vi.fn(() => ({ connected: false, pending: null }));
    const begin = input.begin ?? vi.fn(async () => ({ connected: false, pending: null }));
    const disconnect = input.disconnect ?? vi.fn(async () => undefined);
    const poll = input.poll ?? vi.fn(async () => ({ connected: false, pending: null }));
    const personalConnection = input.personalConnection ?? vi.fn(() => undefined);
    const resolveActor = input.resolveActor ?? vi.fn(async () => ({ id: actor.id }));
    const recordConnection = input.recordConnection ?? vi.fn(async () => undefined);
    const subscriptionBegin =
      input.subscriptionBegin ?? vi.fn(async () => ({ connected: false, pending: null }));
    const subscriptionPoll =
      input.subscriptionPoll ?? vi.fn(async () => ({ connected: false, pending: null }));
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/host/*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    registerHostProductRoutes(app, {
      getHost: async () =>
        ({
          codexAuthStatus: status,
          beginCodexAuth: begin,
          pollCodexAuth: poll,
          disconnectCodex: disconnect,
          personalSubscriptionConnection: personalConnection,
          beginSubscriptionAuth: subscriptionBegin,
          pollSubscriptionAuth: subscriptionPoll,
        }) as unknown as OpenGuiHost,
      resolveSafeDirectory: async (path) => path ?? "/tmp",
      identity: {
        authorizePersonalSubscription: input.authorize ?? vi.fn(async () => undefined),
        resolveDurableActor: resolveActor,
        recordModelConnection: recordConnection,
      } as unknown as IdentityService,
    });
    return {
      app,
      status,
      begin,
      poll,
      disconnect,
      personalConnection,
      recordConnection,
      subscriptionBegin,
      subscriptionPoll,
    };
  }

  test("an allowed member reads and starts only their own subscription sign-in", async () => {
    const authorize = vi.fn(async () => undefined);
    const { app, status, begin } = subscriptionApp({ authorize });

    expect((await app.request("http://localhost/api/host/auth/codex")).status).toBe(200);
    expect(
      (
        await app.request("http://localhost/api/host/auth/codex", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledWith(member);
    expect(status).toHaveBeenCalledWith({ type: "user", id: "member-1", displayName: "Member" });
    expect(begin).toHaveBeenCalledWith({ type: "user", id: "member-1", displayName: "Member" });
  });

  test("rolls back a newly connected personal subscription when metadata persistence fails", async () => {
    const disconnect = vi.fn(async () => undefined);
    const connection = { id: "personal-opaque", modelIds: ["gpt-5"] };
    const { app } = subscriptionApp({
      poll: vi.fn(async () => ({ connected: true, pending: null })),
      personalConnection: vi.fn(() => connection),
      recordConnection: vi.fn(async () => {
        throw new Error("metadata unavailable");
      }),
      disconnect,
    });

    const response = await app.request("http://localhost/api/host/auth/codex/poll", {
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(disconnect).toHaveBeenCalledWith({
      type: "user",
      id: "member-1",
      displayName: "Member",
    });
  });

  test("a member denied by BYOS policy receives 403 from xAI start and poll", async () => {
    const { app, subscriptionBegin, subscriptionPoll } = subscriptionApp({
      authorize: async () => {
        throw new IdentityError(
          "MODEL_CREDENTIAL_POLICY_DENIED",
          403,
          "This credential type is disabled by Host policy",
        );
      },
    });

    expect(
      (await app.request("http://localhost/api/host/auth/xai", { method: "POST" })).status,
    ).toBe(403);
    expect(
      (await app.request("http://localhost/api/host/auth/xai/poll", { method: "POST" })).status,
    ).toBe(403);
    expect(subscriptionBegin).not.toHaveBeenCalled();
    expect(subscriptionPoll).not.toHaveBeenCalled();
  });

  test("a member denied by BYOS policy receives JSON 403 from disconnect", async () => {
    const { app, disconnect } = subscriptionApp({
      authorize: async () => {
        throw new IdentityError(
          "MODEL_CREDENTIAL_POLICY_DENIED",
          403,
          "This credential type is disabled by Host policy",
        );
      },
    });

    const response = await app.request("http://localhost/api/host/auth/codex", {
      method: "DELETE",
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ ok: false });
    expect(disconnect).not.toHaveBeenCalled();
  });

  test("a member denied by BYOS policy receives 403 without touching Host auth", async () => {
    const { app, status, begin } = subscriptionApp({
      authorize: async () => {
        throw new IdentityError(
          "MODEL_CREDENTIAL_POLICY_DENIED",
          403,
          "This credential type is disabled by Host policy",
        );
      },
    });

    expect((await app.request("http://localhost/api/host/auth/codex")).status).toBe(403);
    expect(
      (
        await app.request("http://localhost/api/host/auth/codex", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(status).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });
});

test("projects upstream reasoning capabilities onto member offerings without route secrets", async () => {
  const actor: Actor = { type: "user", id: "member", displayName: "Member", role: "member" };
  const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const offering = { id: "sol", displayName: "Sol", description: null, createdAt: 1, updatedAt: 1 };
  const identity = {
    migrateLegacyModelOfferings: vi.fn(async () => {}),
    listModelOfferings: vi.fn(async () => [offering]),
    resolveModelOfferingForUse: vi.fn(async () => ({
      connectionId: "codex",
      modelId: "gpt-6.1-sol",
    })),
  } as unknown as IdentityService;
  const host = {
    refreshModelCatalogs: vi.fn(async () => {}),
    listModelConnections: () => [
      {
        id: "codex",
        baseUrl: "private-endpoint",
        apiKey: "secret",
        modelIds: ["gpt-6.1-sol"],
        modelCapabilities: {
          "gpt-6.1-sol": {
            reasoning: true,
            reasoningEfforts: efforts,
            context: 272000,
            compat: { private: true },
          },
        },
      },
    ],
  } as unknown as OpenGuiHost;
  const app = new Hono<BackendRequestEnv>();
  app.use("/api/host/*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  registerHostProductRoutes(app, {
    getHost: async () => host,
    identity,
    resolveSafeDirectory: async (path) => path ?? "/tmp",
  });
  const response = await app.request("http://localhost/api/host/model-offerings");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    value: [
      {
        ...offering,
        modelCapabilities: { reasoning: true, reasoningEfforts: efforts, context: 272000 },
      },
    ],
  });
});
