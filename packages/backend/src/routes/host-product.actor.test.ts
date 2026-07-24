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
});
