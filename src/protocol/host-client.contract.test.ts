import { describe, expect, test } from "vite-plus/test";
import { createHostClient } from "./host-client";

function chunkedEventStream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("Host client HTTP contract", () => {
  test("resolves the current base URL and credential for each request", async () => {
    let baseUrl = "https://one.example/";
    let token = "token-one";
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = createHostClient({
      resolveBaseUrl: () => baseUrl,
      resolveToken: () => token,
      fetchImpl: async (url, init) => {
        requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        return Response.json({ ok: true, value: { ok: true, version: "test", shell: "/bin/sh" } });
      },
    });

    await client.health();
    baseUrl = "https://two.example///";
    token = "token-two";
    await client.health();

    expect(requests).toEqual([
      { url: "https://one.example/api/host/health", authorization: "Bearer token-one" },
      { url: "https://two.example/api/host/health", authorization: "Bearer token-two" },
    ]);
  });

  test("surfaces a Host error and falls back safely for malformed responses", async () => {
    const hostError = createHostClient({
      fetchImpl: async () =>
        Response.json({ ok: false, error: "Path not authorized" }, { status: 403 }),
    });
    const malformed = createHostClient({
      fetchImpl: async () => new Response("proxy exploded", { status: 502 }),
    });

    await expect(hostError.health()).rejects.toThrow("Path not authorized");
    await expect(malformed.health()).rejects.toThrow("Host request failed (502)");
  });

  test("redacts credentials from Host and proxy errors before they reach the frontend", async () => {
    const client = createHostClient({
      fetchImpl: async () =>
        Response.json(
          {
            ok: false,
            error:
              'Provider rejected Bearer host-super-secret and {"apiKey":"sk-provider-secret-123"}',
          },
          { status: 502 },
        ),
    });

    await expect(client.health()).rejects.toThrow(
      'Provider rejected Bearer [REDACTED] and {"apiKey":"[REDACTED]"}',
    );
  });

  test("encodes project directories and Session IDs at their transport boundaries", async () => {
    const urls: string[] = [];
    const client = createHostClient({
      baseUrl: "https://host.example/",
      fetchImpl: async (url) => {
        urls.push(url);
        return Response.json({ ok: true, value: [] });
      },
    });

    await client.listSessions("/work/a & b");
    await client.listSkills("/work/a & b");
    await client.searchSessionMessages(["/work/a & b", "/work/c"], "needle #1");
    await client.readSession("session/with?reserved");
    await client.findFiles("/work/a & b", "name #1");

    expect(urls).toEqual([
      "https://host.example/api/host/sessions?directory=%2Fwork%2Fa%20%26%20b",
      "https://host.example/api/host/skills?directory=%2Fwork%2Fa%20%26%20b",
      "https://host.example/api/host/session-message-search",
      "https://host.example/api/host/sessions/session%2Fwith%3Freserved",
      "https://host.example/api/rpc",
    ]);
  });

  test("exposes generation-aware Skills management protocol calls", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = createHostClient({
      baseUrl: "https://host.example",
      fetchImpl: async (url, init) => {
        requests.push({
          url,
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
        });
        return Response.json({ ok: true, value: [] });
      },
    });

    await client.supportedSkillSources();
    await client.listSkillInstallations("project", "/work/a & b");
    await client.installManagedSkill({
      source: "github:acme/skills/demo@main",
      scope: "project",
      directory: "/work/a & b",
      requestId: "request_install_1",
      expectedGeneration: 2,
    });
    await client.updateManagedSkill("demo/unsafe?encoded", {
      scope: "host",
      requestId: "request_update_1",
      expectedGeneration: 3,
    });
    await client.removeManagedSkill("demo", {
      scope: "project",
      directory: "/work/a & b",
      requestId: "request_remove_1",
      expectedGeneration: 4,
    });

    expect(requests).toEqual([
      { url: "https://host.example/api/host/skills/sources", method: "GET" },
      {
        url: "https://host.example/api/host/skills/installations?scope=project&directory=%2Fwork%2Fa+%26+b",
        method: "GET",
      },
      {
        url: "https://host.example/api/host/skills/install",
        method: "POST",
        body: {
          source: "github:acme/skills/demo@main",
          scope: "project",
          directory: "/work/a & b",
          requestId: "request_install_1",
          expectedGeneration: 2,
        },
      },
      {
        url: "https://host.example/api/host/skills/demo%2Funsafe%3Fencoded/update",
        method: "POST",
        body: { scope: "host", requestId: "request_update_1", expectedGeneration: 3 },
      },
      {
        url: "https://host.example/api/host/skills/demo?scope=project&requestId=request_remove_1&directory=%2Fwork%2Fa+%26+b&expectedGeneration=4",
        method: "DELETE",
      },
    ]);
  });

  test("exposes MCP connection management without putting secrets in URLs", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = createHostClient({
      baseUrl: "https://host.example",
      fetchImpl: async (url, init) => {
        requests.push({
          url,
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
        });
        return Response.json({ ok: true, value: [] });
      },
    });
    const connection = {
      id: "calendar/local",
      label: "Calendar",
      enabled: true,
      commandApproved: true as const,
      transport: {
        kind: "stdio" as const,
        command: "node",
        args: ["server.mjs"],
        env: { CALENDAR_TOKEN: "secret" },
      },
    };

    await client.listMcpConnections();
    await client.upsertMcpConnection(connection);
    await client.inspectMcpConnection(connection.id);
    await client.removeMcpConnection(connection.id);

    expect(requests).toEqual([
      { url: "https://host.example/api/host/mcp-connections", method: "GET" },
      {
        url: "https://host.example/api/host/mcp-connections",
        method: "POST",
        body: connection,
      },
      {
        url: "https://host.example/api/host/mcp-connections/calendar%2Flocal/inspect",
        method: "POST",
        body: {},
      },
      {
        url: "https://host.example/api/host/mcp-connections/calendar%2Flocal",
        method: "DELETE",
      },
    ]);
  });

  test("reads and writes Host-wide custom instructions", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = createHostClient({
      baseUrl: "https://host.example",
      fetchImpl: async (url, init) => {
        requests.push({
          url,
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
        });
        return Response.json({ ok: true, value: { text: "Always reply in Spanish." } });
      },
    });

    await expect(client.getCustomInstructions()).resolves.toBe("Always reply in Spanish.");
    await expect(client.setCustomInstructions(" Prefer British spelling. ")).resolves.toBe(
      "Always reply in Spanish.",
    );

    expect(requests).toEqual([
      { url: "https://host.example/api/host/custom-instructions", method: "GET" },
      {
        url: "https://host.example/api/host/custom-instructions",
        method: "PUT",
        body: { text: " Prefer British spelling. " },
      },
    ]);
  });
});

describe("Host client SSE contract", () => {
  test("parses fragmented CRLF frames, ignores comments and malformed data, and signals ready", async () => {
    const client = createHostClient({
      baseUrl: "https://host.example",
      reconnectDelayMs: 60_000,
      fetchImpl: async () =>
        chunkedEventStream([
          ": heartbeat\r\n\r\ndata: {bad json}\r\n\r\nda",
          'ta: {"type":"ready"}\r\n\r\ndata: {"sessionId":"session-1","event":',
          '{"type":"assistant_delta","runId":"run-1","delta":"hello"}}\r\n\r\n',
        ]),
    });
    let ready = 0;
    let unsubscribe = () => {};
    const event = await new Promise<{ sessionId: string }>((resolve) => {
      unsubscribe = client.subscribe(resolve, "session-1", () => {
        ready += 1;
      });
    });
    unsubscribe();

    expect(ready).toBe(1);
    expect(event.sessionId).toBe("session-1");
  });

  test("re-resolves the Host URL and credentials before reconnecting a completed stream", async () => {
    let baseUrl = "https://first.example";
    let token = "first";
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = createHostClient({
      resolveBaseUrl: () => baseUrl,
      resolveToken: () => token,
      reconnectDelayMs: 0,
      fetchImpl: async (url, init) => {
        requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        baseUrl = "https://second.example/";
        token = "second";
        return chunkedEventStream([
          `data: ${JSON.stringify({
            sessionId: "session-1",
            event: { type: "assistant_delta", runId: `run-${requests.length}`, delta: "x" },
          })}\n\n`,
        ]);
      },
    });
    let unsubscribe = () => {};

    await new Promise<void>((resolve) => {
      unsubscribe = client.subscribe(() => {
        if (requests.length === 2) resolve();
      });
    });
    unsubscribe();

    expect(requests).toEqual([
      {
        url: "https://first.example/api/host/events?",
        authorization: "Bearer first",
      },
      {
        url: "https://second.example/api/host/events?",
        authorization: "Bearer second",
      },
    ]);
  });

  test("stops reconnect churn promptly after unsubscribe", async () => {
    let requests = 0;
    const client = createHostClient({
      baseUrl: "https://host.example",
      reconnectDelayMs: 1,
      fetchImpl: async () => {
        requests += 1;
        return chunkedEventStream(['data: {"type":"ready"}\n\n']);
      },
    });
    const unsubscribe = client.subscribe(() => {});
    const deadline = Date.now() + 1_000;
    while (requests < 25 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(requests).toBeGreaterThanOrEqual(25);
    unsubscribe();
    const requestsAtAbort = requests;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(requests).toBe(requestsAtAbort);
  });
});
