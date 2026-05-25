import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createHttpOpenGuiClient, OpenGuiRpcError } from "./http-client";

function json(value: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  });
}

describe("createHttpOpenGuiClient", () => {
  test("loads capabilities", async () => {
    const client = createHttpOpenGuiClient({
      baseUrl: "http://example.test/",
      fetchImpl: async (input) => {
        expect(input).toBe("http://example.test/api/capabilities");
        return json({
          ok: true,
          value: {
            protocolVersion: 1,
            server: {
              workspaces: true,
              projects: false,
              sessions: false,
              events: "websocket",
              auth: false,
              allowedRoots: true,
            },
            agentBackends: ["opencode"],
          },
        });
      },
    });

    const capabilities = await client.capabilities();
    expect(capabilities).toMatchObject({ protocolVersion: 1 });
  });

  test("preserves normalized RPC error details", async () => {
    const client = createHttpOpenGuiClient({
      fetchImpl: async () =>
        json(
          {
            ok: false,
            error: "Claude auth missing",
            code: "AUTH_REQUIRED",
            recoverable: true,
          },
          { status: 500 },
        ),
    });

    try {
      await client.capabilities();
      throw new Error("Expected capabilities to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenGuiRpcError);
      expect(error).toMatchObject({
        name: "OpenGuiRpcError",
        message: "Claude auth missing",
        code: "AUTH_REQUIRED",
        recoverable: true,
      });
    }
  });

  test("creates workspace", async () => {
    const client = createHttpOpenGuiClient({
      fetchImpl: async (_input, init) => {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ name: "Remote" }));
        return json({
          ok: true,
          value: {
            id: "ws_1",
            name: "Remote",
            createdAt: "2026-05-12T00:00:00.000Z",
            updatedAt: "2026-05-12T00:00:00.000Z",
            settings: {},
          },
        });
      },
    });

    const workspace = await client.workspaces.create({ name: "Remote" });
    expect(workspace).toMatchObject({
      id: "ws_1",
      name: "Remote",
    });
  });

  test("connectProject attaches each requested backend through project:add", async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const client = createHttpOpenGuiClient({
      rpcImpl: async <T>(channel: string, args: unknown[] = []) => {
        calls.push({ channel, args });
        return { success: true, data: true } as T;
      },
    });

    const result = await client.agentBackends.connectProject({
      config: {
        workspaceId: "local",
        baseUrl: "http://127.0.0.1:4096",
        directory: "/repo",
      },
      backendIds: ["opencode", "pi"],
    });

    expect(result).toEqual({
      connectedBackendIds: ["opencode", "pi"],
      errors: [],
    });
    expect(calls).toEqual([
      {
        channel: "opencode:project:add",
        args: [
          {
            workspaceId: "local",
            baseUrl: "http://127.0.0.1:4096",
            directory: "/repo",
          },
        ],
      },
      {
        channel: "pi:project:add",
        args: [
          {
            workspaceId: "local",
            baseUrl: "http://127.0.0.1:4096",
            directory: "/repo",
          },
        ],
      },
    ]);
  });

  test("connectProject reports per-backend attachment failures", async () => {
    const client = createHttpOpenGuiClient({
      rpcImpl: async <T>(channel: string) => {
        if (channel === "opencode:project:add") {
          return { success: true, data: true } as T;
        }
        return { success: false, error: "Pi attach failed" } as T;
      },
    });

    const result = await client.agentBackends.connectProject({
      config: {
        workspaceId: "local",
        baseUrl: "http://127.0.0.1:4096",
        directory: "/repo",
      },
      backendIds: ["opencode", "pi"],
    });

    expect(result).toEqual({
      connectedBackendIds: ["opencode"],
      errors: [{ backendId: "pi", error: "Pi attach failed" }],
    });
  });
});
