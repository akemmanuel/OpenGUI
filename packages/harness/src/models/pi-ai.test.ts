import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { benchmarkPiSerialization, PiAiTransport, toPiContext, type PiAiRoute } from "./pi-ai.ts";
import { toAnthropicMessages, toChatMessages } from "./openai-chat.ts";
import {
  createModelCachePolicy,
  deriveModelCacheKey,
  deriveModelConnectionKey,
  ModelTransportError,
  type ModelRequest,
  type ModelStreamEvent,
} from "./transport.ts";

const route: PiAiRoute = {
  backendId: "private-backend",
  label: "Private backend",
  protocol: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  modelId: "gpt-test",
  apiKey: "sk-super-secret",
  reasoning: true,
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  const systemPrompt = "System";
  const tools = ["read", "shell"] as const;
  return {
    identity: { hostId: "host", sessionId: "session", runId: "run", principalId: "user:1" },
    projectDirectory: "/project",
    systemPrompt,
    tools,
    context: [
      {
        type: "user_message",
        text: "inspect",
        model: { connectionId: route.backendId, modelId: route.modelId },
        reasoning: "high",
      },
      {
        type: "assistant_message",
        text: "working",
        replay: {
          items: [
            { type: "reasoning", encryptedContent: '{"type":"reasoning","id":"rs_1"}' },
            { type: "text", signature: '{"v":1,"id":"msg_1"}' },
          ],
        },
      },
      { type: "tool_call", toolCallId: "call_old|fc_old", name: "read", input: { path: "a.png" } },
      {
        type: "tool_result",
        toolCallId: "call_old|fc_old",
        name: "read",
        output: {
          content: "image",
          attachments: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        },
      },
    ],
    cache: createModelCachePolicy({
      systemPrompt,
      tools,
      permissionScope: { project: "/project", tools },
      skillRevisions: ["skill@1"],
    }),
    delivery: { timeoutMs: 1234, maxRetries: 3, maxRetryDelayMs: 99 },
    ...overrides,
  };
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: route.backendId,
    model: route.modelId,
    usage: {
      input: 11,
      output: 7,
      cacheRead: 8,
      cacheWrite: 2,
      reasoning: 3,
      totalTokens: 28,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
    ...overrides,
  };
}

function fakeStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) stream.push(event);
    stream.end();
  });
  return stream;
}

describe("PiAiTransport", () => {
  test("maps durable context, images, tool history, and opaque replay without pi state", () => {
    const model = {
      id: route.modelId,
      name: route.label,
      api: "openai-responses",
      provider: route.backendId,
      baseUrl: route.baseUrl,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    } as Model<"openai-responses">;
    const context = toPiContext(request(), model);

    expect(context.systemPrompt).toBe("System");
    expect(context.tools?.map((tool) => tool.name)).toEqual(["read", "shell"]);
    expect(context.messages).toMatchObject([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinkingSignature: '{"type":"reasoning","id":"rs_1"}' },
          { type: "text", textSignature: '{"v":1,"id":"msg_1"}' },
          { type: "toolCall", id: "call_old|fc_old" },
        ],
      },
      {
        role: "toolResult",
        content: [
          { type: "text", text: "image" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      },
    ]);
  });

  test("is semantically differential with native history conversion", () => {
    const model = {
      id: route.modelId,
      name: route.label,
      api: "openai-completions",
      provider: route.backendId,
      baseUrl: route.baseUrl,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    } as Model<"openai-completions">;
    const durable = request();
    const pi = toPiContext(durable, model);
    const nativeChat = toChatMessages(durable.context);
    const nativeAnthropic = toAnthropicMessages(durable.context);

    expect(pi.messages.map((item) => item.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(nativeChat.map((item) => item.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(nativeChat[1]).toMatchObject({
      tool_calls: [{ id: "call_old|fc_old", function: { name: "read" } }],
    });
    expect(nativeAnthropic.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_old|fc_old" }],
    });
    expect(JSON.stringify(pi.messages)).toContain("aW1hZ2U=");
    expect(JSON.stringify(nativeAnthropic)).toContain("aW1hZ2U=");
  });

  test("preserves parallel tool calls as one assistant turn", () => {
    const parallel = request();
    parallel.context = [
      parallel.context[0]!,
      { type: "assistant_message", text: "I will inspect all three." },
      { type: "tool_call", toolCallId: "call-1", name: "read", input: { path: "one" } },
      { type: "tool_call", toolCallId: "call-2", name: "read", input: { path: "two" } },
      { type: "tool_call", toolCallId: "call-3", name: "read", input: { path: "three" } },
      { type: "tool_result", toolCallId: "call-1", name: "read", output: "one" },
      { type: "tool_result", toolCallId: "call-2", name: "read", output: "two" },
      { type: "tool_result", toolCallId: "call-3", name: "read", output: "three" },
    ];
    const model = {
      id: route.modelId,
      name: route.label,
      api: "openai-completions",
      provider: route.backendId,
      baseUrl: route.baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    } as Model<"openai-completions">;

    const context = toPiContext(parallel, model);

    expect(context.messages.map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "toolResult",
    ]);
    expect(context.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect all three." },
        { type: "toolCall", id: "call-1" },
        { type: "toolCall", id: "call-2" },
        { type: "toolCall", id: "call-3" },
      ],
    });
  });

  test("forwards deltas and parallel tool argument bytes immediately, then maps usage/cache/replay", async () => {
    let capturedContext: Context | undefined;
    let capturedOptions: SimpleStreamOptions | undefined;
    const partial = message({
      content: [
        { type: "text", text: "A", textSignature: '{"v":1,"id":"msg_new"}' },
        {
          type: "thinking",
          thinking: "R",
          thinkingSignature: '{"type":"reasoning","id":"rs_new","encrypted_content":"opaque"}',
        },
        { type: "toolCall", id: "one|fc_one", name: "read", arguments: {} },
        { type: "toolCall", id: "two|fc_two", name: "shell", arguments: {} },
      ],
    });
    const events: AssistantMessageEvent[] = [
      { type: "start", partial },
      { type: "text_delta", contentIndex: 0, delta: "A", partial },
      { type: "thinking_delta", contentIndex: 1, delta: "R", partial },
      { type: "toolcall_delta", contentIndex: 2, delta: '{"path":', partial },
      { type: "toolcall_delta", contentIndex: 3, delta: '{"command":', partial },
      {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: { type: "toolCall", id: "one|fc_one", name: "read", arguments: { path: "a" } },
        partial,
      },
      {
        type: "toolcall_end",
        contentIndex: 3,
        toolCall: {
          type: "toolCall",
          id: "two|fc_two",
          name: "shell",
          arguments: { command: "pwd" },
        },
        partial,
      },
      { type: "done", reason: "toolUse", message: partial },
    ];
    const transport = new PiAiTransport({
      resolve: async () => route,
      streams: {
        "openai-responses": (_model, context, options) => {
          capturedContext = context;
          capturedOptions = options;
          return fakeStream(events);
        },
      },
      now: (() => {
        let value = 1_000;
        return () => value++;
      })(),
    });

    const output = [];
    for await (const event of transport.stream(request(), new AbortController().signal))
      output.push(event);

    expect(output.map((event) => event.type)).toEqual([
      "text_delta",
      "reasoning_delta",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call",
      "tool_call",
      "completed",
    ]);
    expect(capturedContext?.messages.at(-1)).toMatchObject({ role: "toolResult" });
    const key = deriveModelCacheKey(request(), {
      backendId: route.backendId,
      upstreamModelId: route.modelId,
      protocol: "openai-responses",
    });
    expect(capturedOptions).toMatchObject({
      apiKey: "sk-super-secret",
      sessionId: key,
      cacheRetention: "short",
      reasoning: "high",
      timeoutMs: 1234,
      maxRetries: 3,
      maxRetryDelayMs: 99,
    });
    expect(output.at(-1)).toMatchObject({
      type: "completed",
      response: {
        usage: { input: 11, output: 7, cacheRead: 8, cacheWrite: 2, reasoning: 3, total: 28 },
        cache: { key, readTokens: 8, writeTokens: 2 },
        replay: {
          items: [
            {
              type: "text",
              signature: '{"v":1,"id":"msg_new"}',
            },
            {
              type: "reasoning",
              encryptedContent: '{"type":"reasoning","id":"rs_new","encrypted_content":"opaque"}',
            },
          ],
        },
      },
    });
    expect(JSON.stringify(output)).not.toContain("sk-super-secret");
  });

  test("does not wait for stream completion before exposing the first delta", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const partial = message({ content: [{ type: "text", text: "first" }], stopReason: "stop" });
    const transport = new PiAiTransport({
      resolve: () => route,
      streams: {
        "openai-responses": () => {
          const stream = createAssistantMessageEventStream();
          void (async () => {
            stream.push({ type: "start", partial });
            stream.push({ type: "text_delta", contentIndex: 0, delta: "first", partial });
            await gate;
            stream.push({ type: "done", reason: "stop", message: partial });
            stream.end();
          })();
          return stream;
        },
      },
    });
    const iterator = transport
      .stream(request(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "text_delta", delta: "first" },
    });
    release();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "completed" } });
  });

  test.each([
    ["provider error", "401 invalid api key sk-super-secret", "authentication"],
    ["overflow", "context_length_exceeded: too many tokens", "invalid_request"],
  ])("normalizes %s without leaking credentials", async (_name, errorMessage, code) => {
    const failed = message({ stopReason: "error", errorMessage });
    const transport = new PiAiTransport({
      resolve: () => route,
      streams: {
        "openai-responses": () => fakeStream([{ type: "error", reason: "error", error: failed }]),
      },
    });
    let caught: unknown;
    try {
      for await (const _event of transport.stream(request(), new AbortController().signal))
        void _event;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelTransportError);
    expect((caught as ModelTransportError).normalized.code).toBe(code);
    expect((caught as Error).message).not.toContain("sk-super-secret");
  });

  test("distinguishes abort and rejects truncated streams", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = message({ stopReason: "aborted", errorMessage: "Request was aborted" });
    const abortTransport = new PiAiTransport({
      resolve: () => route,
      streams: {
        "openai-responses": () =>
          fakeStream([{ type: "error", reason: "aborted", error: aborted }]),
      },
    });
    await expect(async () => {
      for await (const _event of abortTransport.stream(request(), controller.signal)) void _event;
    }).rejects.toMatchObject({ normalized: { code: "aborted" } });

    const truncated = new PiAiTransport({
      resolve: () => route,
      streams: { "openai-responses": () => fakeStream([]) },
    });
    await expect(async () => {
      for await (const _event of truncated.stream(request(), new AbortController().signal))
        void _event;
    }).rejects.toMatchObject({ normalized: { code: "protocol" } });
  });

  test("serialization benchmark is bounded and deterministic in work performed", () => {
    const result = benchmarkPiSerialization(request(), route, 200);
    expect(result).toMatchObject({ iterations: 200 });
    expect(result.bytes).toBeGreaterThan(100_000);
    expect(result.elapsedMs).toBeLessThan(250);
  });

  test("multi-tool continuation serialization remains bounded", () => {
    const multiTool = request();
    multiTool.context = [
      multiTool.context[0]!,
      ...Array.from({ length: 24 }, (_, index) => [
        {
          type: "tool_call" as const,
          toolCallId: `call_${index}`,
          name: index % 2 ? "shell" : "read",
          input: index % 2 ? { command: `printf ${index}` } : { path: `file-${index}.txt` },
        },
        {
          type: "tool_result" as const,
          toolCallId: `call_${index}`,
          name: index % 2 ? "shell" : "read",
          output: { content: `result-${index}` },
        },
      ]).flat(),
    ];
    const result = benchmarkPiSerialization(multiTool, route, 200);
    expect(result.bytes).toBeGreaterThan(1_000_000);
    expect(result.elapsedMs).toBeLessThan(500);
  });

  test("first-event forwarding adds bounded adapter overhead", async () => {
    const partial = message({ content: [{ type: "text", text: "x" }], stopReason: "stop" });
    const transport = new PiAiTransport({
      resolve: () => route,
      streams: {
        "openai-responses": () =>
          fakeStream([
            { type: "text_delta", contentIndex: 0, delta: "x", partial },
            { type: "done", reason: "stop", message: partial },
          ]),
      },
    });
    const started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      const iterator = transport
        .stream(request(), new AbortController().signal)
        [Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        value: { type: "text_delta", delta: "x" },
      });
      await iterator.return?.();
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test.each([
    ["openai-chat", "prompt_cache_key"],
    ["openai-responses", "prompt_cache_key"],
    ["anthropic-messages", "cache_control"],
  ] as const)("pi %s request contains OpenGUI cache policy", async (protocol, cacheField) => {
    let payload: unknown;
    const longRequest = request();
    longRequest.cache = { ...longRequest.cache!, retention: "long" };
    const inspectedRoute = { ...route, protocol };
    const transport = new PiAiTransport({
      resolve: () => inspectedRoute,
      inspectPayload: (value) => {
        payload = value;
        throw new Error("inspection complete");
      },
    });
    await expect(async () => {
      for await (const _event of transport.stream(longRequest, new AbortController().signal))
        void _event;
    }).rejects.toBeInstanceOf(ModelTransportError);

    const serialized = JSON.stringify(payload);
    const key = deriveModelCacheKey(longRequest, {
      backendId: route.backendId,
      upstreamModelId: route.modelId,
      protocol: protocol === "openai-chat" ? "openai-chat" : protocol,
    });
    expect(serialized).toContain(cacheField);
    if (protocol === "anthropic-messages") {
      expect(payload).toMatchObject({
        system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }],
      });
    } else {
      expect(payload).toMatchObject({
        prompt_cache_key: key,
      });
      if (protocol === "openai-chat") {
        expect(payload).toHaveProperty("prompt_cache_retention", "24h");
      } else {
        expect(payload).not.toHaveProperty("prompt_cache_retention");
      }
    }
    expect(serialized).not.toContain("sk-super-secret");
    expect(JSON.stringify(longRequest)).not.toContain("sk-super-secret");
  });

  test("uses current Responses explicit cache-disable option when configured", async () => {
    let payload: unknown;
    const disabled = request();
    disabled.cache = { ...disabled.cache!, mode: "off", retention: "none" };
    const transport = new PiAiTransport({
      resolve: () => ({
        ...route,
        compat: { supportsExplicitPromptCacheMode: true },
      }),
      inspectPayload: (value) => {
        payload = value;
        throw new Error("inspection complete");
      },
    });
    await expect(async () => {
      for await (const _event of transport.stream(disabled, new AbortController().signal))
        void _event;
    }).rejects.toBeInstanceOf(ModelTransportError);
    expect(payload).toMatchObject({
      prompt_cache_options: { mode: "explicit" },
    });
    expect(payload).toHaveProperty("prompt_cache_key", undefined);
  });

  test("uses GPT-5.6 cache options and stable-prefix breakpoint on the SSE fallback", async () => {
    let payload: any;
    const transport = new PiAiTransport({
      openAiResponsesTransport: "sse",
      resolve: () => ({ ...route, modelId: "gpt-5.6" }),
      inspectPayload: (value) => {
        payload = value;
        throw new Error("inspection complete");
      },
    });
    await expect(async () => {
      for await (const _event of transport.stream(request(), new AbortController().signal))
        void _event;
    }).rejects.toBeInstanceOf(ModelTransportError);
    expect(payload).toMatchObject({
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
    });
    expect(payload).not.toHaveProperty("prompt_cache_retention");
    const stable = payload.input.find(
      (item: Record<string, any>) => item.role === "developer" || item.role === "system",
    );
    expect(stable?.content).toContainEqual(
      expect.objectContaining({ prompt_cache_breakpoint: { mode: "explicit" } }),
    );
  });

  test("resolves credentials only when iteration starts", async () => {
    const resolve = vi.fn(() => route);
    const transport = new PiAiTransport({
      resolve,
      streams: {
        "openai-responses": () =>
          fakeStream([{ type: "done", reason: "stop", message: message({ stopReason: "stop" }) }]),
      },
    });
    const iterable = transport.stream(request(), new AbortController().signal);
    expect(resolve).not.toHaveBeenCalled();
    for await (const _event of iterable) void _event;
    expect(resolve).toHaveBeenCalledOnce();
  });

  test("routes Codex through pi-ai with stable per-session WebSocket identity", async () => {
    const options: SimpleStreamOptions[] = [];
    const codexRoute: PiAiRoute = {
      ...route,
      backendId: "chatgpt-codex",
      providerId: "openai-codex",
      protocol: "codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.4",
      transport: "auto",
    };
    const complete = message({
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.4",
      stopReason: "stop",
      responseId: "resp_1",
      content: [{ type: "text", text: "ok", textSignature: '{"v":1,"id":"msg_1"}' }],
    });
    const transport = new PiAiTransport({
      resolve: () => codexRoute,
      streams: {
        "codex-responses": (_model, _context, streamOptions) => {
          options.push(streamOptions ?? {});
          return fakeStream([{ type: "done", reason: "stop", message: complete }]);
        },
      },
    });
    const first = request();
    const second = request({
      identity: { ...first.identity!, runId: "run-2" },
      cache: { ...first.cache!, generation: first.cache!.generation },
    });
    for await (const _event of transport.stream(first, new AbortController().signal)) void _event;
    for await (const _event of transport.stream(second, new AbortController().signal)) void _event;

    const expectedIdentity = deriveModelConnectionKey(first, {
      backendId: codexRoute.backendId,
      upstreamModelId: codexRoute.modelId,
      protocol: "codex-responses",
    });
    expect(options).toMatchObject([
      { sessionId: expectedIdentity, transport: "auto" },
      { sessionId: expectedIdentity, transport: "auto" },
    ]);
    transport.close();
  });

  test("isolates Codex sockets by principal and falls back to SSE when the pool is busy", async () => {
    const releases: Array<() => void> = [];
    const observed: Array<Pick<SimpleStreamOptions, "sessionId" | "transport">> = [];
    const codexRoute: PiAiRoute = {
      ...route,
      protocol: "codex-responses",
      providerId: "openai-codex",
      transport: "auto",
    };
    const transport = new PiAiTransport({
      resolve: () => codexRoute,
      maxCodexConnections: 1,
      streams: {
        "codex-responses": (_model, _context, streamOptions) => {
          observed.push({
            sessionId: streamOptions?.sessionId,
            transport: streamOptions?.transport,
          });
          const stream = createAssistantMessageEventStream();
          releases.push(() => {
            stream.push({ type: "done", reason: "stop", message: message({ stopReason: "stop" }) });
            stream.end();
          });
          return stream;
        },
      },
    });
    const first = transport.stream(request(), new AbortController().signal)[Symbol.asyncIterator]();
    const otherRequest = request({
      identity: { ...request().identity!, principalId: "user:other", sessionId: "other" },
    });
    const second = transport
      .stream(otherRequest, new AbortController().signal)
      [Symbol.asyncIterator]();
    const firstPending = first.next();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const secondPending = second.next();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(
      deriveModelConnectionKey(request(), {
        backendId: codexRoute.backendId,
        upstreamModelId: codexRoute.modelId,
        protocol: "codex-responses",
      }),
    ).not.toBe(
      deriveModelConnectionKey(otherRequest, {
        backendId: codexRoute.backendId,
        upstreamModelId: codexRoute.modelId,
        protocol: "codex-responses",
      }),
    );
    expect(observed[0]?.transport).toBe("auto");
    expect(observed[1]?.transport).toBe("sse");
    releases.forEach((release) => release());
    await Promise.all([firstPending, secondPending]);
    await first.return?.();
    await second.return?.();
    transport.close();
  });

  test("continues Codex incrementally on the reused pi-ai WebSocket", async () => {
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
    ).toString("base64url");
    const bodies: Array<{ input: unknown[]; previous_response_id?: string }> = [];
    let connections = 0;
    class MockWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = MockWebSocket.OPEN;

      constructor() {
        super();
        connections += 1;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(raw: string) {
        const body = JSON.parse(raw) as { input: unknown[]; previous_response_id?: string };
        bodies.push(body);
        const index = bodies.length;
        const events =
          index === 1
            ? [
                {
                  type: "response.output_item.added",
                  item: {
                    type: "message",
                    id: "msg_1",
                    role: "assistant",
                    status: "in_progress",
                    content: [],
                  },
                },
                { type: "response.content_part.added", part: { type: "output_text", text: "" } },
                { type: "response.output_text.delta", delta: "A" },
                {
                  type: "response.output_item.done",
                  item: {
                    type: "message",
                    id: "msg_1",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "A" }],
                  },
                },
                {
                  type: "response.completed",
                  response: {
                    id: "resp_1",
                    status: "completed",
                    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
                  },
                },
              ]
            : [
                {
                  type: "response.completed",
                  response: {
                    id: "resp_2",
                    status: "completed",
                    usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2 },
                  },
                },
              ];
        queueMicrotask(() => {
          for (const event of events) {
            this.dispatchEvent(
              Object.assign(new Event("message"), { data: JSON.stringify(event) }),
            );
          }
        });
      }

      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unexpected SSE", { status: 500 })),
    );
    const codexRoute: PiAiRoute = {
      ...route,
      backendId: "chatgpt-codex",
      providerId: "openai-codex",
      protocol: "codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.4",
      apiKey: `header.${payload}.signature`,
      transport: "websocket-cached",
    };
    const transport = new PiAiTransport({ resolve: () => codexRoute });
    const firstRequest = request({ context: [request().context[0]!] });
    let firstResponse:
      | NonNullable<Extract<ModelStreamEvent, { type: "completed" }>["response"]>
      | undefined;
    for await (const event of transport.stream(firstRequest, new AbortController().signal)) {
      if (event.type === "completed" && event.response) firstResponse = event.response;
    }
    const secondRequest = request({
      identity: { ...firstRequest.identity!, runId: "run-2" },
      context: [
        firstRequest.context[0]!,
        { type: "assistant_message", text: "A", replay: firstResponse?.replay },
        {
          type: "user_message",
          text: "continue",
          model: { connectionId: "private-backend", modelId: "gpt-test" },
          reasoning: "high",
        },
      ],
    });
    for await (const _event of transport.stream(secondRequest, new AbortController().signal))
      void _event;

    expect(connections).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.previous_response_id).toBe("resp_1");
    expect(bodies[1]?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "continue" }] },
    ]);
    expect(global.fetch).not.toHaveBeenCalled();
    transport.close();
    vi.unstubAllGlobals();
  });

  test("uses pi-ai SSE fallback only when the Codex socket fails before output", async () => {
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
    ).toString("base64url");
    class FailedWebSocket {
      constructor() {
        throw new Error("socket unavailable");
      }
    }
    vi.stubGlobal("WebSocket", FailedWebSocket);
    let sseHeaders = new Headers();
    let sseBody: BodyInit | null | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sseHeaders = new Headers(init?.headers);
      sseBody = init?.body;
      return new Response(
        'data: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}\n\n' +
          'data: {"type":"response.content_part.added","part":{"type":"output_text","text":""}}\n\n' +
          'data: {"type":"response.output_text.delta","delta":"fallback"}\n\n' +
          'data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"fallback"}]}}\n\n' +
          'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n',
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new PiAiTransport({
      resolve: () => ({
        ...route,
        providerId: "openai-codex",
        protocol: "codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        apiKey: `header.${payload}.signature`,
        transport: "auto",
      }),
    });
    const output: ModelStreamEvent[] = [];
    const fallbackRequest = request({ context: [request().context[0]!] });
    for await (const event of transport.stream(fallbackRequest, new AbortController().signal))
      output.push(event);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sseHeaders.get("content-encoding")).toBe("zstd");
    expect(sseBody).toBeInstanceOf(Uint8Array);
    expect(output).toContainEqual({ type: "text_delta", delta: "fallback" });
    expect(output.at(-1)).toMatchObject({ type: "completed" });
    transport.close();
    vi.unstubAllGlobals();
  });
});
