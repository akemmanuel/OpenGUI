import { describe, expect, test } from "vite-plus/test";
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
              workspaces: false,
              projects: false,
              sessions: true,
              events: "sse",
              auth: false,
              allowedRoots: true,
            },
            harnesses: ["opencode"],
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

  test("loads remote harness resources over HTTP instead of Electron RPC", async () => {
    const rpcCalls: string[] = [];
    const httpCalls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const client = createHttpOpenGuiClient({
      baseUrl: "http://127.0.0.1:4096",
      rpcImpl: async <T>(channel: string): Promise<T> => {
        rpcCalls.push(channel);
        return { success: true, data: {} } as T;
      },
      fetchImpl: async (input, init) => {
        const requestBody = typeof init?.body === "string" ? init.body : "{}";
        const body = JSON.parse(requestBody) as { channel?: string };
        httpCalls.push({
          url: String(input),
          body,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (body.channel === "opencode:providers") {
          return json({ ok: true, value: { success: true, data: { providers: [] } } });
        }
        if (body.channel === "opencode:agents") {
          return json({ ok: true, value: { success: true, data: [] } });
        }
        if (body.channel === "opencode:commands") {
          return json({ ok: true, value: { success: true, data: [] } });
        }
        throw new Error(`Unexpected channel ${body.channel}`);
      },
    });

    await client.harnesses.loadResources({
      harnessId: "opencode",
      target: {
        workspaceId: "remote",
        directory: "/root/Workspace",
        baseUrl: "http://91.98.206.29:4839",
        authToken: "remote-token",
      },
    });

    expect(rpcCalls).toEqual([]);
    expect(httpCalls).toHaveLength(3);
    expect(httpCalls.map((call) => call.url)).toEqual([
      "http://91.98.206.29:4839/api/rpc",
      "http://91.98.206.29:4839/api/rpc",
      "http://91.98.206.29:4839/api/rpc",
    ]);
    expect(httpCalls.every((call) => call.authorization === "Bearer remote-token")).toBe(true);
  });

  test("keeps local harness resources on Electron RPC even when the default URL is remote", async () => {
    const rpcCalls: string[] = [];
    const httpCalls: string[] = [];
    const client = createHttpOpenGuiClient({
      resolveBaseUrl: () => "http://91.98.206.29:4839",
      rpcImpl: async <T>(channel: string): Promise<T> => {
        rpcCalls.push(channel);
        return {
          success: true,
          data: channel.endsWith(":providers") ? { providers: [] } : [],
        } as T;
      },
      fetchImpl: async (input) => {
        httpCalls.push(String(input));
        throw new Error("Local resource loading should not use HTTP");
      },
    });

    await client.harnesses.loadResources({
      harnessId: "opencode",
      target: { workspaceId: "local", directory: "/home/me/project" },
    });

    expect(httpCalls).toEqual([]);
    expect(rpcCalls).toEqual(["opencode:providers", "opencode:agents", "opencode:commands"]);
  });

  test("can restrict available harness descriptors for a remote workspace", () => {
    const client = createHttpOpenGuiClient({
      resolveHarnessIds: () => ["opencode"],
    });

    expect(client.harnesses.list().map((backend) => backend.id)).toEqual(["opencode"]);
    expect(client.harnesses.get("opencode")?.id).toBe("opencode");
    expect(client.harnesses.get("pi")).toBeUndefined();
  });

  test("registerDirectory registers harnesses for a directory over HTTP", async () => {
    const calls: Array<{ input: string; method?: string }> = [];
    const client = createHttpOpenGuiClient({
      baseUrl: "http://example.test",
      fetchImpl: async (input, init) => {
        calls.push({ input, method: init?.method });
        const url = String(input);
        if (url.endsWith("/api/directories/%2Frepo/register") && init?.method === "POST") {
          expect(init.body).toBe(
            JSON.stringify({
              harnessIds: ["opencode", "pi"],
              config: {
                directory: "/repo",
              },
            }),
          );
          return json({
            ok: true,
            value: {
              connectedHarnessIds: ["opencode", "pi"],
              errors: [],
            },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    const result = await client.harnesses.registerDirectory({
      config: {
        workspaceId: "local",
        baseUrl: "http://127.0.0.1:4096",
        directory: "/repo",
      },
      harnessIds: ["opencode", "pi"],
    });

    expect(result).toEqual({
      connectedHarnessIds: ["opencode", "pi"],
      errors: [],
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toContain("/api/directories/%2Frepo/register");
  });

  test("creates sessions over HTTP and maps them into frontend session ids", async () => {
    const client = createHttpOpenGuiClient({
      baseUrl: "http://example.test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/sessions") && init?.method === "POST") {
          return json({
            ok: true,
            value: {
              id: "session_1",
              rawId: "native-1",
              workspaceId: "local",
              directory: "project_1",
              harnessId: "pi",
              title: "Chat",
              status: "unknown",
              createdAt: "2026-05-12T00:00:00.000Z",
              updatedAt: "2026-05-12T00:00:00.000Z",
            },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    const session = await client.sessions.create({
      harnessId: "pi",
      title: "Chat",
      target: { directory: "/repo", workspaceId: "local" },
    });

    expect(session).toMatchObject({
      id: "pi:native-1",
      title: "Chat",
      _harnessId: "pi",
      _rawId: "native-1",
      _projectDir: "/repo",
      _workspaceId: "local",
    });
  });

  test("routes runtime revert through session project target", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const sessionRecord = {
      id: "session_1",
      rawId: "native-1",
      directory: "project_1",
      harnessId: "opencode",
      title: "Chat",
      status: "unknown",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:00:00.000Z",
    };
    const client = createHttpOpenGuiClient({
      baseUrl: "http://example.test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (
          url.includes("/api/sessions/opencode%3Asession_1/revert") &&
          url.includes("directory=%2Frepo") &&
          method === "POST"
        ) {
          return json({ ok: true, value: sessionRecord });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    });

    const session = await client.harnesses
      .get("opencode")
      ?.runtime.revertSession("opencode:session_1", "msg_1", undefined, {
        directory: "/repo",
        workspaceId: "workspace-1",
      });

    expect(session).toMatchObject({ id: "opencode:native-1", _projectDir: "/repo" });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      expect.stringContaining("POST http://example.test/api/sessions/opencode%3Asession_1/revert"),
    ]);
    expect(calls[0]?.url).toContain("directory=%2Frepo");
    expect(calls[0]?.body).toEqual({ messageId: "msg_1" });
  });

  test("sends session and project context with question replies", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = createHttpOpenGuiClient({
      baseUrl: "http://example.test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (url.endsWith("/api/questions/question_1/reply") && init?.method === "POST") {
          return json({ ok: true, value: true });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    await client.sessions.replyQuestion({
      sessionId: "opencode:session_1",
      requestId: "question_1",
      answers: [["Yes"]],
      harnessId: "opencode",
      target: { directory: "/repo", workspaceId: "workspace-1" },
    });

    expect(calls.at(-1)).toEqual({
      url: "http://example.test/api/questions/question_1/reply",
      method: "POST",
      body: {
        sessionId: "opencode:session_1",
        answers: [["Yes"]],
        harnessId: "opencode",
        workspaceId: "workspace-1",
        directory: "/repo",
      },
    });
  });

  test("does not call project API for question replies", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = createHttpOpenGuiClient({
      baseUrl: "http://example.test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (url.endsWith("/api/questions/question_1/reply") && method === "POST") {
          return json({ ok: true, value: true });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    });

    await client.sessions.replyQuestion({
      sessionId: "opencode:session_1",
      requestId: "question_1",
      answers: [["Yes"]],
      harnessId: "opencode",
      target: { directory: "/untracked", workspaceId: "workspace-1" },
    });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://example.test/api/questions/question_1/reply",
    ]);
    expect(calls.at(-1)?.body).toEqual({
      sessionId: "opencode:session_1",
      answers: [["Yes"]],
      harnessId: "opencode",
      workspaceId: "workspace-1",
      directory: "/untracked",
    });
  });

  test("sends auth token with RPC requests", async () => {
    const originalFetch = globalThis.fetch;
    let authHeader = "";
    globalThis.fetch = (async (_input, init) => {
      authHeader = new Headers(init?.headers).get("authorization") ?? "";
      return json({ ok: true, value: "/home/emmanuel" });
    }) as typeof fetch;

    try {
      const client = createHttpOpenGuiClient({
        baseUrl: "http://example.test",
        token: "secret-token",
      });
      const homeDir = await client.runtime.getHomeDir();
      expect(homeDir).toBe("/home/emmanuel");
      expect(authHeader).toBe("Bearer secret-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends auth token in event subscriptions", () => {
    const urls: string[] = [];

    class MockEventSource {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        urls.push(url);
      }

      close() {}
    }

    const client = createHttpOpenGuiClient({
      baseUrl: "http://example.test",
      token: "secret-token",
      eventSourceImpl: MockEventSource,
    });

    const unsubscribe = client.harnesses.subscribe(() => {});
    unsubscribe();

    expect(urls).toEqual(["http://example.test/api/events/v2?token=secret-token"]);
  });

  test("reconnects SSE subscriptions with the last seen event id as cursor", () => {
    const urls: string[] = [];
    const streams: MockEventSource[] = [];

    class MockEventSource {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        urls.push(url);
        streams.push(this);
      }

      close() {}
    }

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    try {
      const client = createHttpOpenGuiClient({
        baseUrl: "http://example.test",
        eventSourceImpl: MockEventSource,
      });

      const unsubscribe = client.harnesses.subscribe(() => {});
      streams[0]?.onmessage?.({
        data: JSON.stringify({ ok: true }),
        lastEventId: "evt_123",
      } as MessageEvent<string>);
      streams[0]?.onerror?.(new Event("error"));
      unsubscribe();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(urls).toEqual([
      "http://example.test/api/events/v2",
      "http://example.test/api/events/v2?cursor=evt_123",
    ]);
  });

  test("uses remembered remote base URL for session delete when target has no baseUrl", async () => {
    const calls: string[] = [];
    const client = createHttpOpenGuiClient({
      baseUrl: "http://local.test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "http://remote.test/api/sessions/query" && init?.method === "POST") {
          return json({
            ok: true,
            value: {
              items: [
                {
                  workspaceId: "workspace-1",
                  directory: "/repo",
                  sessions: [
                    {
                      id: "session_1",
                      rawId: "native-1",
                      workspaceId: "workspace-1",
                      directory: "project_1",
                      harnessId: "opencode",
                      title: "Remote chat",
                      status: "unknown",
                      createdAt: "2026-05-12T00:00:00.000Z",
                      updatedAt: "2026-05-12T00:00:00.000Z",
                    },
                  ],
                },
              ],
              errors: [],
            },
          });
        }
        if (
          url.startsWith("http://remote.test/api/sessions/session_1") &&
          init?.method === "DELETE" &&
          url.includes("directory=%2Frepo") &&
          url.includes("harnessId=opencode")
        ) {
          return json({ ok: true, value: true });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    await client.sessions.query({
      projects: [
        {
          workspaceId: "workspace-1",
          directory: "/repo",
          baseUrl: "http://remote.test",
        },
      ],
      harnessIds: ["opencode"],
    });

    await client.sessions.delete({
      sessionId: "opencode:native-1",
      harnessId: "opencode",
      target: { directory: "/repo", workspaceId: "workspace-1" },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("POST http://remote.test/api/sessions/query");
    expect(calls[1]).toMatch(/^DELETE http:\/\/remote\.test\/api\/sessions\/session_1\?/);
    expect(calls[1]).toContain("directory=%2Frepo");
    expect(calls[1]).toContain("harnessId=opencode");
  });

  test("scopes aliased session requests to the resolved project", async () => {
    const calls: string[] = [];
    const client = createHttpOpenGuiClient({
      baseUrl: "http://example.test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (
          url.includes("/api/sessions/pi%3Anative-1/abort") &&
          url.includes("directory=%2Frepo") &&
          init?.method === "POST"
        ) {
          return json({ ok: true, value: true });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    await client.sessions.abort({
      sessionId: "pi:native-1",
      harnessId: "pi",
      target: { directory: "/repo", workspaceId: "workspace-1" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/sessions/pi%3Anative-1/abort");
    expect(calls[0]).toContain("directory=%2Frepo");
  });

  test("propagates RPC errors from getMessages instead of returning an empty page", async () => {
    const client = createHttpOpenGuiClient({
      baseUrl: "http://example.test",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/messages") && url.includes("pi%3Amissing")) {
          return json(
            {
              ok: false,
              error: "Session not found",
              code: "NOT_FOUND",
              recoverable: false,
            },
            { status: 404 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    await expect(
      client.sessions.getMessages({
        sessionId: "pi:missing",
        harnessId: "pi",
        options: { directory: "/repo", limit: 30 },
      }),
    ).rejects.toMatchObject({
      message: "Session not found",
      code: "NOT_FOUND",
    });
  });
});
