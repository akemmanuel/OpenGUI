import { describe, expect, test, vi } from "vite-plus/test";
import {
  chatDeltaEvents,
  OpenAiChatTransport,
  shouldRetryChatCompletion,
  toChatMessages,
} from "./openai-chat.ts";

describe("chatDeltaEvents", () => {
  test("projects interleaved reasoning_content separately from answer text", () => {
    expect(chatDeltaEvents({ reasoning_content: "Check the factors." })).toEqual([
      { type: "reasoning_delta", delta: "Check the factors." },
    ]);
    expect(chatDeltaEvents({ content: "The answer is 42." })).toEqual([
      { type: "text_delta", delta: "The answer is 42." },
    ]);
  });
});

describe("toChatMessages", () => {
  test("keeps true parallel tool calls on one assistant message", () => {
    expect(
      toChatMessages([
        {
          type: "user_message",
          text: "inspect",
          model: { connectionId: "test", modelId: "test" },
          reasoning: "none",
        },
        { type: "assistant_message", text: "I'll inspect both." },
        { type: "tool_call", toolCallId: "call-1", name: "read", input: { path: "a" } },
        { type: "tool_call", toolCallId: "call-2", name: "read", input: { path: "b" } },
        { type: "tool_result", toolCallId: "call-1", name: "read", output: "a" },
        { type: "tool_result", toolCallId: "call-2", name: "read", output: "b" },
      ]),
    ).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "I'll inspect both.",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: '{"path":"a"}' },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "read", arguments: '{"path":"b"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "a" },
      { role: "tool", tool_call_id: "call-2", content: "b" },
    ]);
  });

  test("does not rewrite sequential tool rounds into one parallel tool_calls block", () => {
    expect(
      toChatMessages([
        {
          type: "user_message",
          text: "inspect",
          model: { connectionId: "test", modelId: "test" },
          reasoning: "none",
        },
        { type: "tool_call", toolCallId: "call-1", name: "read", input: { path: "a" } },
        { type: "tool_result", toolCallId: "call-1", name: "read", output: "a" },
        { type: "tool_call", toolCallId: "call-2", name: "shell", input: { command: "ls" } },
        { type: "tool_result", toolCallId: "call-2", name: "shell", output: "ok" },
      ]),
    ).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "a" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-2",
            type: "function",
            function: { name: "shell", arguments: '{"command":"ls"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-2", content: "ok" },
    ]);
  });
});

describe("shouldRetryChatCompletion", () => {
  test("retries transient upstream failures even when a gateway reports HTTP 400", () => {
    expect(shouldRetryChatCompletion(400, "Error from provider: Upstream request failed")).toBe(
      true,
    );
    expect(shouldRetryChatCompletion(400, "Invalid tool schema")).toBe(false);
  });
});

describe("OpenAiChatTransport authentication", () => {
  test("omits tools unavailable for the model turn", async () => {
    let requestBody: string | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const transport = new OpenAiChatTransport({ fetchImpl: fetchImpl as typeof fetch });
    transport.setConnections([
      { id: "test", label: "Test", baseUrl: "https://example.test/v1", modelIds: ["test"] },
    ]);
    for await (const _event of transport.stream(
      {
        systemPrompt: "restricted",
        projectDirectory: "/project",
        tools: ["read", "write", "edit"],
        context: [
          {
            type: "user_message",
            text: "hello",
            model: { connectionId: "test", modelId: "test" },
            reasoning: "none",
          },
        ],
      },
      new AbortController().signal,
    )) {
      // Drain the response.
    }
    const body = JSON.parse(requestBody ?? "") as {
      tools: Array<{ function: { name: string } }>;
    };
    expect(body.tools.map((tool) => tool.function.name)).toEqual(["read", "write", "edit"]);
  });

  test("sends an OpenCode Go API key to its documented chat completions endpoint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const transport = new OpenAiChatTransport({ fetchImpl: fetchImpl as typeof fetch });
    transport.setConnections([
      {
        id: "opencode-go",
        label: "OpenCode Go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "go-api-key",
        modelIds: ["glm-5.2"],
      },
    ]);

    const events = [];
    for await (const event of transport.stream(
      {
        systemPrompt: "help",
        projectDirectory: "/project",
        context: [
          {
            type: "user_message",
            text: "hello",
            model: { connectionId: "opencode-go", modelId: "glm-5.2" },
            reasoning: "none",
          },
        ],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer go-api-key" }),
        body: expect.stringContaining('"model":"glm-5.2"'),
      }),
    );
    expect(events).toEqual([{ type: "text_delta", delta: "ok" }, { type: "completed" }]);
  });

  test("does not retry an invalid OpenCode Go API key", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid API key", { status: 401 }));
    const transport = new OpenAiChatTransport({ fetchImpl: fetchImpl as typeof fetch });
    transport.setConnections([
      {
        id: "opencode-go",
        label: "OpenCode Go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "invalid",
        modelIds: ["glm-5.2"],
      },
    ]);
    const events = transport.stream(
      {
        systemPrompt: "help",
        projectDirectory: "/project",
        context: [
          {
            type: "user_message",
            text: "hello",
            model: { connectionId: "opencode-go", modelId: "glm-5.2" },
            reasoning: "none",
          },
        ],
      },
      new AbortController().signal,
    );

    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow("invalid API key");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("routes Qwen through the documented Anthropic-compatible endpoint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
          { status: 200 },
        ),
    );
    const transport = new OpenAiChatTransport({ fetchImpl: fetchImpl as typeof fetch });
    transport.setConnections([
      {
        id: "opencode-go",
        label: "OpenCode Go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "go-api-key",
        modelIds: ["qwen3.7-max"],
        modelRoutes: { "qwen3.7-max": "anthropic-messages" },
      },
    ]);

    const events = [];
    for await (const event of transport.stream(
      {
        systemPrompt: "help",
        projectDirectory: "/project",
        context: [
          {
            type: "user_message",
            text: "hello",
            model: { connectionId: "opencode-go", modelId: "qwen3.7-max" },
            reasoning: "none",
          },
        ],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/messages",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "go-api-key",
          "anthropic-version": "2023-06-01",
        }),
        body: expect.stringContaining('"model":"qwen3.7-max"'),
      }),
    );
    expect(events).toEqual([{ type: "text_delta", delta: "ok" }, { type: "completed" }]);
  });
});
