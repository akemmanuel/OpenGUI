import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { OpenAiChatTransport } from "./openai-chat.ts";
import { OpenCodeRequestHeaders } from "./opencode-headers.ts";
import { PiAiTransport } from "./pi-ai.ts";
import type { ModelRequest } from "./transport.ts";

const protocols = [
  {
    protocol: "openai-chat",
    route: "openai-chat",
    events: [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }],
  },
  {
    protocol: "anthropic-messages",
    route: "anthropic-messages",
    events: [
      {
        type: "message_start",
        message: { id: "msg_reply", model: "test", usage: { input_tokens: 1, output_tokens: 0 } },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ],
  },
  {
    protocol: "openai-responses",
    route: "responses",
    events: [
      {
        type: "response.completed",
        response: {
          id: "resp_reply",
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        },
      },
    ],
  },
] as const;

function request(): ModelRequest {
  return {
    identity: { hostId: "host", principalId: "user:1", sessionId: "session", runId: "run" },
    projectDirectory: "/project",
    systemPrompt: "help",
    context: [
      {
        type: "user_message",
        text: "hello",
        model: { connectionId: "test", modelId: "test" },
        reasoning: "none",
      },
    ],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe.each(["pi-ai", "native"] as const)("%s OpenCode requests", (adapter) => {
  describe.each(["zen", "go"] as const)("%s", (provider) => {
    test.each(protocols)("sends the extension headers over $protocol", async (wire) => {
      const baseUrl = `https://opencode.ai/zen/${provider === "go" ? "go/" : ""}v1`;
      const apiKey = provider === "go" ? "go-test-key" : undefined;
      const observed: Headers[] = [];
      const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        observed.push(headers);
        expect(headers.get("user-agent")).toBe("opencode/1.18.30");
        expect(headers.get("x-opencode-client")).toBe("cli");
        expect(headers.get("x-opencode-project")).toBe("global");
        expect(headers.get("x-opencode-session")).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
        expect(headers.get("x-opencode-request")).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
        if (apiKey) {
          expect(
            headers.get(wire.protocol === "anthropic-messages" ? "x-api-key" : "authorization"),
          ).toBe(wire.protocol === "anthropic-messages" ? apiKey : `Bearer ${apiKey}`);
        }
        return new Response(
          wire.events
            .map(
              (event) =>
                `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      vi.stubGlobal("fetch", fetchImpl);
      const transport =
        adapter === "pi-ai"
          ? new PiAiTransport({
              resolve: () => ({
                backendId: "test",
                label: "Test",
                protocol: wire.protocol,
                baseUrl,
                modelId: "test",
                apiKey,
                authHeader: apiKey ? undefined : false,
              }),
            })
          : new OpenAiChatTransport({ fetchImpl });
      if (transport instanceof OpenAiChatTransport) {
        transport.setConnections([
          {
            id: "test",
            label: "Test",
            baseUrl,
            apiKey,
            modelIds: ["test"],
            modelRoutes: { test: wire.route },
          },
        ]);
      }
      try {
        for (let turn = 0; turn < 2; turn += 1) {
          const events = [];
          for await (const event of transport.stream(request(), new AbortController().signal)) {
            events.push(event);
          }
          expect(events.at(-1)?.type).toBe("completed");
        }
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0]?.[0]).toEqual(expect.stringContaining(`${baseUrl}/`));
        expect(observed[1]?.get("x-opencode-session")).toBe(observed[0]?.get("x-opencode-session"));
        expect(observed[1]?.get("x-opencode-request")).not.toBe(
          observed[0]?.get("x-opencode-request"),
        );
        if (!apiKey && adapter === "pi-ai") {
          expect(observed.every((headers) => !headers.has("authorization"))).toBe(true);
        }
      } finally {
        if (transport instanceof PiAiTransport) transport.close();
      }
    });
  });
});

describe("OpenCode header scope", () => {
  test.each([
    "https://api.openai.com/v1",
    "https://opencode.ai.example.com/zen/v1",
    "https://example.com/opencode.ai/zen/v1",
    "https://opencode.ai/zenith/v1",
    "https://opencode.ai/other/v1",
    "http://opencode.ai/zen/v1",
    "not a URL",
  ])("leaves %s untouched", (baseUrl) => {
    expect(new OpenCodeRequestHeaders().forRequest(baseUrl, request())).toEqual({});
  });

  test("isolates provider session IDs by Host, principal and Session without leaking durable IDs", () => {
    const headers = new OpenCodeRequestHeaders();
    const original = request();
    const baseUrl = "https://opencode.ai/zen/v1";
    const first = headers.forRequest(baseUrl, original);
    for (const field of ["hostId", "principalId", "sessionId"] as const) {
      const changed = request();
      changed.identity![field] += "-other";
      expect(headers.forRequest(baseUrl, changed)["x-opencode-session"]).not.toBe(
        first["x-opencode-session"],
      );
    }
    expect(first["x-opencode-session"]).not.toContain(original.identity!.sessionId);
    expect(headers.forRequest(baseUrl, original)["x-opencode-session"]).toBe(
      first["x-opencode-session"],
    );
    headers.clear();
    expect(headers.forRequest(baseUrl, original)["x-opencode-session"]).not.toBe(
      first["x-opencode-session"],
    );
  });
});
