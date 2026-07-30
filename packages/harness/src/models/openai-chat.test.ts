import { describe, expect, test, vi } from "vite-plus/test";
import {
  chatDeltaEvents,
  OpenAiChatTransport,
  shouldRetryChatCompletion,
  toAnthropicMessages,
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

  test("injects image tool results as native image content", () => {
    const context = [
      {
        type: "tool_call" as const,
        toolCallId: "call-image",
        name: "read",
        input: { path: "pixel.png" },
      },
      {
        type: "tool_result" as const,
        toolCallId: "call-image",
        name: "read",
        output: {
          content: "Read image file [image/png]",
          attachments: [{ type: "image", mimeType: "image/png", data: "abc123" }],
        },
      },
    ];

    expect(toChatMessages(context)).toContainEqual({
      role: "user",
      content: [
        { type: "text", text: "Attached image(s) from tool result:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
      ],
    });
    expect(toAnthropicMessages(context).at(-1)).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          content: [
            { type: "text", text: "Read image file [image/png]" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "abc123" },
            },
          ],
        },
      ],
    });
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
  test("decodes multibyte chat chunks and accepts a terminal marker without a final newline", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"café 🧪"}}]}\r\ndata: [DONE]',
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 3) {
          controller.enqueue(bytes.slice(offset, offset + 3));
        }
        controller.close();
      },
    });
    const transport = new OpenAiChatTransport({
      fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch,
    });
    transport.setConnections([
      { id: "test", label: "Test", baseUrl: "https://example.test/v1", modelIds: ["test"] },
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
            model: { connectionId: "test", modelId: "test" },
            reasoning: "none",
          },
        ],
      },
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([{ type: "text_delta", delta: "café 🧪" }, { type: "completed" }]);
  });

  test("retries without image content when a model rejects images", async () => {
    const bodies: string[] = [];
    const transport = new OpenAiChatTransport({
      fetchImpl: (async (_url, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : "");
        return bodies.length === 1
          ? new Response(
              JSON.stringify({
                error: {
                  message: "Error from provider (Console): Upstream request failed",
                  type: "invalid_request_error",
                },
              }),
              { status: 400 },
            )
          : new Response("data: [DONE]", { status: 200 });
      }) as typeof fetch,
    });
    transport.setConnections([
      { id: "test", label: "Test", baseUrl: "https://example.test/v1", modelIds: ["test"] },
    ]);

    const events = [];
    for await (const event of transport.stream(
      {
        systemPrompt: "help",
        projectDirectory: "/project",
        context: [
          {
            type: "user_message",
            text: "inspect",
            model: { connectionId: "test", modelId: "test" },
            reasoning: "none",
          },
          { type: "tool_call", toolCallId: "call-image", name: "read", input: {} },
          {
            type: "tool_result",
            toolCallId: "call-image",
            name: "read",
            output: {
              content: "Read image file [image/png]",
              attachments: [{ type: "image", mimeType: "image/png", data: "abc123" }],
            },
          },
        ],
      },
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([{ type: "completed" }]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("data:image/png;base64,abc123");
    expect(bodies[1]).not.toContain("data:image/png;base64,abc123");
    expect(bodies[1]).toContain("Current model does not support images");
  });

  test.each(["stop", "tool_calls", "length", "content_filter"])(
    "treats the %s finish reason as a completed compatible stream",
    async (finishReason) => {
      const transport = new OpenAiChatTransport({
        fetchImpl: (async () =>
          new Response(
            `data: {"choices":[{"delta":{},"finish_reason":"${finishReason}"}]}`,
          )) as typeof fetch,
      });
      transport.setConnections([
        { id: "test", label: "Test", baseUrl: "https://example.test/v1", modelIds: ["test"] },
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
              model: { connectionId: "test", modelId: "test" },
              reasoning: "none",
            },
          ],
        },
        new AbortController().signal,
      ))
        events.push(event);

      expect(events).toEqual([{ type: "completed" }]);
    },
  );

  test("rejects a chat stream that closes before its completion marker", async () => {
    const transport = new OpenAiChatTransport({
      fetchImpl: (async () =>
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
          status: 200,
        })) as typeof fetch,
    });
    transport.setConnections([
      { id: "test", label: "Test", baseUrl: "https://example.test/v1", modelIds: ["test"] },
    ]);

    const consume = async () => {
      for await (const _event of transport.stream(
        {
          systemPrompt: "help",
          projectDirectory: "/project",
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
        // Drain until the premature EOF is diagnosed.
      }
    };

    await expect(consume()).rejects.toThrow("ended before completion");
  });

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
      tools: Array<{
        function: {
          name: string;
          description: string;
          parameters: { required?: string[] };
        };
      }>;
    };
    expect(body.tools.map((tool) => tool.function.name)).toEqual(["read", "write", "edit"]);
    expect(body.tools[0]?.function.description).toContain("Read a text file");
    expect(body.tools[0]?.function.parameters.required).toEqual(["path"]);
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

  test("cancels an active OpenCode Zen chat response when its Run is aborted", async () => {
    let responseCancelled = false;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
              );
            },
            cancel() {
              responseCancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const transport = new OpenAiChatTransport({ fetchImpl: fetchImpl as typeof fetch });
    transport.setConnections([
      {
        id: "opencode-zen",
        label: "OpenCode Zen",
        baseUrl: "https://opencode.ai/zen/v1",
        modelIds: ["deepseek-v4-flash-free"],
      },
    ]);
    const controller = new AbortController();
    const iterator = transport
      .stream(
        {
          systemPrompt: "help",
          projectDirectory: "/project",
          context: [
            {
              type: "user_message",
              text: "hello",
              model: {
                connectionId: "opencode-zen",
                modelId: "deepseek-v4-flash-free",
              },
              reasoning: "maximum",
            },
          ],
        },
        controller.signal,
      )
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "text_delta", delta: "partial" },
    });
    const pending = iterator.next();
    controller.abort();

    await expect(
      Promise.race([
        pending.then(
          () => "settled",
          () => "settled",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 50)),
      ]),
    ).resolves.toBe("settled");
    expect(responseCancelled).toBe(true);
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

    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow("API key");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["openai-chat" as const, "/chat/completions"],
    ["anthropic-messages" as const, "/messages"],
  ])("redacts credentials echoed by a failed %s endpoint", async (route, expectedPath) => {
    const secret = "sk-private-never-log";
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(`authorization failed for ${secret}`, { status: 401 });
    });
    const transport = new OpenAiChatTransport({ fetchImpl: fetchImpl as typeof fetch });
    transport.setConnections([
      {
        id: "test",
        label: "Test",
        baseUrl: "https://example.test/v1",
        apiKey: secret,
        modelIds: ["test"],
        modelRoutes: { test: route },
      },
    ]);
    const iterator = transport.stream(
      {
        systemPrompt: "help",
        projectDirectory: "/project",
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
    );

    const error = await iterator[Symbol.asyncIterator]()
      .next()
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain("[REDACTED]");
    expect(String(error)).not.toContain(secret);
    expect(requestedUrl).toBe(`https://example.test/v1${expectedPath}`);
  });

  test("routes Qwen through the documented Anthropic-compatible endpoint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
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

  test("dispatches a final Anthropic message_stop frame at EOF with CRLF framing", async () => {
    const transport = new OpenAiChatTransport({
      fetchImpl: (async () =>
        new Response(
          'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\r\n\r\nevent: message_stop\r\ndata: {"type":"message_stop"}',
          { status: 200 },
        )) as typeof fetch,
    });
    transport.setConnections([
      {
        id: "anthropic",
        label: "Anthropic compatible",
        baseUrl: "https://example.test/v1",
        modelIds: ["model"],
        modelRoutes: { model: "anthropic-messages" },
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
            model: { connectionId: "anthropic", modelId: "model" },
            reasoning: "none",
          },
        ],
      },
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([{ type: "text_delta", delta: "ok" }, { type: "completed" }]);
  });
});
