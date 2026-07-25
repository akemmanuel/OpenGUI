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
