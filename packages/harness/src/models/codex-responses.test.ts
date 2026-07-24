import { describe, expect, test, vi } from "vite-plus/test";
import { CodexResponsesTransport, codexResponseEvents } from "./codex-responses.ts";

describe("codexResponseEvents", () => {
  test("projects streamed reasoning summaries", () => {
    expect(
      codexResponseEvents({
        type: "response.reasoning_summary_text.delta",
        delta: "I should inspect the project.",
      }),
    ).toEqual([{ type: "reasoning_delta", delta: "I should inspect the project." }]);
    expect(
      codexResponseEvents({
        type: "response.reasoning_summary.delta",
        delta: "Then calculate.",
      }),
    ).toEqual([{ type: "reasoning_delta", delta: "Then calculate." }]);
  });

  test("projects a reasoning summary delivered only on the completed item", () => {
    expect(
      codexResponseEvents({
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "I multiplied the values." }],
        },
      }),
    ).toEqual([{ type: "reasoning_delta", delta: "I multiplied the values." }]);
  });
});

describe("CodexResponsesTransport", () => {
  test("omits tools unavailable for the model turn", async () => {
    let requestBody: string | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const transport = new CodexResponsesTransport({
      getCredential: async () => ({ accessToken: "token", accountId: "account" }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    for await (const _event of transport.stream(
      {
        systemPrompt: "restricted",
        projectDirectory: "/project",
        tools: ["read", "write", "edit"],
        context: [
          {
            type: "user_message",
            text: "hello",
            model: { connectionId: "codex", modelId: "codex" },
            reasoning: "none",
          },
        ],
      },
      new AbortController().signal,
    )) {
      // Drain the response.
    }
    const body = JSON.parse(requestBody ?? "") as {
      tools: Array<{ name: string }>;
    };
    expect(body.tools.map((tool) => tool.name)).toEqual(["read", "write", "edit"]);
  });

  test("routes an OAuth token to the SuperGrok proxy with provider-specific errors", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 401 }),
    );
    const transport = new CodexResponsesTransport({
      endpoint: "https://cli-chat-proxy.grok.com/v1/responses",
      requestLabel: "SuperGrok",
      unauthorizedMessage: "SuperGrok authorization failed",
      headers: {
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-identifier": "opengui",
      },
      getCredential: async () => ({ accessToken: "xai-oauth", accountId: "" }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    const events = transport.stream(
      {
        systemPrompt: "help",
        projectDirectory: "/project",
        context: [
          {
            type: "user_message",
            text: "hello",
            model: { connectionId: "supergrok", modelId: "grok-build" },
            reasoning: "medium",
          },
        ],
      },
      new AbortController().signal,
    );

    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow(
      "SuperGrok authorization failed",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/responses",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer xai-oauth",
          "x-xai-token-auth": "xai-grok-cli",
          "x-grok-client-identifier": "opengui",
        }),
      }),
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toContain('"model":"grok-build"');
  });
});
