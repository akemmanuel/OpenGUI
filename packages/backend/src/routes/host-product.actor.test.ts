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

describe("personal provider sign-in authorization", () => {
  const member: Actor = {
    type: "user",
    id: "member-1",
    displayName: "Member",
    role: "member",
  };
  const durableMember = { type: "user", id: "member-1", displayName: "Member" };
  const denied = async () => {
    throw new IdentityError(
      "MODEL_CREDENTIAL_POLICY_DENIED",
      403,
      "This credential type is disabled by Host policy",
    );
  };

  function providerApp(input: {
    actor?: Actor;
    authorize?: ReturnType<typeof vi.fn> | (() => Promise<void>);
    status?: ReturnType<typeof vi.fn>;
    personalConnection?: ReturnType<typeof vi.fn>;
    recordConnection?: ReturnType<typeof vi.fn>;
  }) {
    const actor = input.actor ?? member;
    const begin = vi.fn(() => ({ providerId: "openai-codex", state: "running", events: [] }));
    const status = input.status ?? vi.fn(() => undefined);
    const disconnect = vi.fn(async () => "personal-opaque");
    const personalConnection = input.personalConnection ?? vi.fn(() => undefined);
    const recordConnection = input.recordConnection ?? vi.fn(async () => undefined);
    const authorize = input.authorize ?? vi.fn(async () => undefined);
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/host/*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    registerHostProductRoutes(app, {
      getHost: async () =>
        ({
          beginProviderLogin: begin,
          providerLoginStatus: status,
          disconnectProvider: disconnect,
          personalProviderConnection: personalConnection,
        }) as unknown as OpenGuiHost,
      resolveSafeDirectory: async (path) => path ?? "/tmp",
      identity: {
        authorizePersonalCredential: authorize,
        resolveDurableActor: vi.fn(async () => ({ id: actor.id })),
        recordModelConnection: recordConnection,
        removeModelConnection: vi.fn(async () => undefined),
      } as unknown as IdentityService,
    });
    const start = (method: string) =>
      app.request("http://localhost/api/host/providers/openai-codex/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method }),
      });
    return { app, start, begin, status, disconnect, authorize, recordConnection };
  }

  test("a member signs in only within their own scope, under the matching policy", async () => {
    const { start, begin, authorize } = providerApp({});

    expect((await start("oauth")).status).toBe(200);
    expect((await start("api_key")).status).toBe(200);
    expect(authorize).toHaveBeenNthCalledWith(1, member, "byos");
    expect(authorize).toHaveBeenNthCalledWith(2, member, "byok");
    expect(begin).toHaveBeenCalledWith("openai-codex", "oauth", durableMember);
    expect((await start("password")).status).toBe(400);
  });

  test("administrators manage the Host's connections without personal policy checks", async () => {
    const { start, begin, authorize } = providerApp({
      actor: { type: "user", id: "admin-1", displayName: "Admin", role: "admin" },
    });
    expect((await start("oauth")).status).toBe(200);
    expect(authorize).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledWith("openai-codex", "oauth", undefined);
  });

  test("records a completed personal sign-in as a user-plane connection", async () => {
    const recordConnection = vi.fn(async () => undefined);
    const { app } = providerApp({
      status: vi.fn(() => ({ providerId: "openai-codex", state: "succeeded", events: [] })),
      personalConnection: vi.fn(() => ({ id: "personal-opaque", authType: "oauth" })),
      recordConnection,
    });
    const response = await app.request("http://localhost/api/host/providers/openai-codex/login");
    expect(response.status).toBe(200);
    expect(recordConnection).toHaveBeenCalledWith(
      { id: "member-1" },
      { id: "personal-opaque", plane: "user", credentialKind: "byos" },
    );
  });

  test("rolls back a newly connected personal sign-in when metadata persistence fails", async () => {
    const { app, disconnect } = providerApp({
      status: vi.fn(() => ({ providerId: "openai-codex", state: "succeeded", events: [] })),
      personalConnection: vi.fn(() => ({ id: "personal-opaque", authType: "api_key" })),
      recordConnection: vi.fn(async () => {
        throw new Error("metadata unavailable");
      }),
    });

    const response = await app.request("http://localhost/api/host/providers/openai-codex/login");

    expect(response.status).toBe(400);
    expect(disconnect).toHaveBeenCalledWith("openai-codex", durableMember);
  });

  test("a member denied by policy receives JSON 403 without touching Host auth", async () => {
    const { start, begin } = providerApp({ authorize: denied });

    const response = await start("oauth");
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ ok: false });
    expect((await start("api_key")).status).toBe(403);
    expect(begin).not.toHaveBeenCalled();
  });

  test("a member can always remove their own credential, even when policy now denies it", async () => {
    const { app, disconnect } = providerApp({ authorize: denied });
    const response = await app.request("http://localhost/api/host/providers/openai-codex", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(disconnect).toHaveBeenCalledWith("openai-codex", durableMember);
  });

  test("API-key actors cannot manage provider credentials", async () => {
    const { start, begin } = providerApp({
      actor: { type: "api_key", id: "key-1", displayName: "Automation" } as unknown as Actor,
    });
    expect((await start("api_key")).status).toBe(403);
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
