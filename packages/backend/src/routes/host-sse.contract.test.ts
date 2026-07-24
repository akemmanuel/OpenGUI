import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { OpenGuiHost } from "../host/opengui-host.ts";
import type { BackendRequestEnv } from "../http/request-context.ts";
import type { Actor } from "../identity/types.ts";
import { registerHostProductRoutes } from "./host-product.ts";

describe("Host SSE transport contract", () => {
  test("frames ready before events emitted during subscription and cleans up on disconnect", async () => {
    const actor: Actor = {
      type: "user",
      id: "member-1",
      displayName: "Member",
      role: "member",
    };
    const unsubscribe = vi.fn();
    const event = {
      sessionId: "session-1",
      event: { type: "assistant_delta", runId: "run-1", delta: "hello" },
    };
    const host = {
      requiresScopedEvents: async () => true,
      subscribe: async (
        _actor: unknown,
        _sessionId: string | undefined,
        listener: (value: unknown) => void,
      ) => {
        listener(event);
        return unsubscribe;
      },
    } as unknown as OpenGuiHost;
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/host/*", async (context, next) => {
      context.set("actor", actor);
      await next();
    });
    registerHostProductRoutes(app, {
      getHost: async () => host,
      resolveSafeDirectory: async (path) => path ?? "/tmp",
    });
    const controller = new AbortController();
    const response = await app.request("http://localhost/api/host/events?sessionId=session-1", {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    const second = await reader.read();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(new TextDecoder().decode(first.value) + new TextDecoder().decode(second.value)).toBe(
      `data: {"type":"ready"}\n\ndata: ${JSON.stringify(event)}\n\n`,
    );

    controller.abort();
    await reader.closed;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
