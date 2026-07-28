import { EventEmitter } from "node:events";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import {
  OpenAiResponsesWebSocketTransport,
  openAiResponsesWebSocketRequest,
  type DirectOpenAiResponsesRoute,
} from "./openai-responses-websocket.ts";
import { PiAiTransport } from "./pi-ai.ts";
import {
  createModelCachePolicy,
  ModelTransportError,
  type ModelRequest,
  type ModelStreamEvent,
} from "./transport.ts";

const route: DirectOpenAiResponsesRoute = {
  backendId: "openai",
  baseUrl: "https://api.openai.com/v1",
  modelId: "gpt-5.6",
  apiKey: "sk-test-secret",
  reasoning: true,
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  const systemPrompt = "Stable developer instructions";
  return {
    identity: { hostId: "host", sessionId: "session", runId: "run", principalId: "user:1" },
    projectDirectory: "/project",
    systemPrompt,
    tools: ["read"],
    context: [
      {
        type: "user_message",
        text: "inspect",
        model: { connectionId: "openai", modelId: "gpt-5.6" },
        reasoning: "high",
      },
    ],
    cache: createModelCachePolicy({
      systemPrompt,
      tools: ["read"],
      permissionScope: { project: "/project" },
      skillRevisions: ["read@1"],
      retention: "long",
    }),
    delivery: { timeoutMs: 1_000, maxRetries: 2, maxRetryDelayMs: 100 },
    ...overrides,
  };
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly sent: Array<Record<string, any>> = [];
  readonly onSend: (body: Record<string, any>, socket: FakeSocket) => void;

  constructor(onSend: (body: Record<string, any>, socket: FakeSocket) => void) {
    super();
    this.onSend = onSend;
    queueMicrotask(() => this.emit("open"));
  }

  send(raw: string) {
    const body = JSON.parse(raw) as Record<string, any>;
    this.sent.push(body);
    this.onSend(body, this);
  }

  message(event: Record<string, any>) {
    queueMicrotask(() => this.emit("message", JSON.stringify(event)));
  }

  close() {
    this.readyState = 3;
  }

  terminate() {
    this.readyState = 3;
  }
}

async function drainDirect(
  transport: OpenAiResponsesWebSocketTransport,
  input: ModelRequest,
  signal = new AbortController().signal,
) {
  const iterator = transport.stream(input, signal, route);
  const events: ModelStreamEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return { events, delivered: next.value };
    events.push(next.value);
  }
}

function completed(id: string, usage: Record<string, unknown> = {}) {
  return {
    type: "response.completed",
    response: {
      id,
      model: "gpt-5.6-2026-05-01",
      status: "completed",
      usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24, ...usage },
    },
  };
}

describe("official OpenAI Responses WebSocket payload", () => {
  test("has a deterministic GPT-5.6 cache golden with explicit stable-prefix breakpoint", () => {
    expect(openAiResponsesWebSocketRequest(request(), route, "ogc_key")).toMatchInlineSnapshot(`
      {
        "include": [
          "reasoning.encrypted_content",
        ],
        "input": [
          {
            "content": [
              {
                "prompt_cache_breakpoint": {
                  "mode": "explicit",
                },
                "text": "Stable developer instructions",
                "type": "input_text",
              },
            ],
            "role": "developer",
            "type": "message",
          },
          {
            "content": [
              {
                "text": "inspect",
                "type": "input_text",
              },
            ],
            "role": "user",
            "type": "message",
          },
        ],
        "model": "gpt-5.6",
        "prompt_cache_key": "ogc_key",
        "prompt_cache_options": {
          "mode": "implicit",
          "ttl": "30m",
        },
        "reasoning": {
          "effort": "high",
          "summary": "auto",
        },
        "store": false,
        "tools": [
          {
            "description": "Read a text file or image (jpg, png, gif, webp, bmp) from an absolute or Project-relative path. Images are injected into the model as attachments.",
            "name": "read",
            "parameters": {
              "properties": {
                "endLine": {
                  "type": "number",
                },
                "path": {
                  "type": "string",
                },
                "startLine": {
                  "type": "number",
                },
              },
              "required": [
                "path",
              ],
              "type": "object",
            },
            "strict": false,
            "type": "function",
          },
        ],
        "type": "response.create",
      }
    `);
  });

  test("uses legacy 24h retention only for documented models and keeps custom fallback safe", () => {
    const legacy = { ...route, modelId: "gpt-5.4" };
    expect(openAiResponsesWebSocketRequest(request(), legacy, "key")).toMatchObject({
      prompt_cache_key: "key",
      prompt_cache_retention: "24h",
    });
    expect(
      openAiResponsesWebSocketRequest(
        request(),
        { ...legacy, baseUrl: "https://custom.test/v1" },
        "key",
      ),
    ).not.toHaveProperty("prompt_cache_retention");
    const disabled = request({ cache: { ...request().cache!, mode: "off", retention: "none" } });
    expect(openAiResponsesWebSocketRequest(disabled, route, undefined)).toMatchObject({
      prompt_cache_options: { mode: "explicit" },
    });
  });
});

describe("official OpenAI Responses WebSocket delivery", () => {
  test("forwards text, reasoning, tool bytes and structured cache usage immediately", async () => {
    const socket = new FakeSocket((_body, target) => {
      target.message({ type: "response.output_text.delta", delta: "A" });
      target.message({ type: "response.reasoning_summary_text.delta", delta: "R" });
      target.message({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read" },
      });
      target.message({
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"path":',
      });
      target.message({
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        name: "read",
        arguments: '{"path":"a"}',
      });
      target.message({
        type: "response.output_item.done",
        item: { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
      });
      target.message(
        completed("resp_1", {
          input_tokens_details: { cached_tokens: 12, cache_write_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 2 },
        }),
      );
    });
    const transport = new OpenAiResponsesWebSocketTransport({ websocketFactory: () => socket });
    const result = await drainDirect(transport, request());
    expect(result.delivered).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      "text_delta",
      "reasoning_delta",
      "tool_call_delta",
      "tool_call",
      "completed",
    ]);
    expect(result.events.at(-1)).toMatchObject({
      response: {
        responseId: "resp_1",
        usage: { input: 5, output: 4, cacheRead: 12, cacheWrite: 3, reasoning: 2, total: 24 },
        cache: { readTokens: 12, writeTokens: 3 },
        replay: { items: [{ id: "rs_1", encryptedContent: "opaque" }] },
      },
    });
    expect(JSON.stringify(result.events)).not.toContain(route.apiKey);
    transport.close();
  });

  test("reuses one isolated Session socket and continues with only new inputs", async () => {
    const sockets: FakeSocket[] = [];
    const transport = new OpenAiResponsesWebSocketTransport({
      websocketFactory: () => {
        const socket = new FakeSocket((_body, target) =>
          target.message(completed(`resp_${target.sent.length}`)),
        );
        sockets.push(socket);
        return socket;
      },
    });
    const first = request();
    await drainDirect(transport, first);
    const second = request({
      identity: { ...first.identity!, runId: "run-2" },
      context: [
        ...first.context,
        { type: "assistant_message", text: "done" },
        {
          type: "user_message",
          text: "continue",
          model: { connectionId: "openai", modelId: "gpt-5.6" },
          reasoning: "high",
        },
      ],
    });
    await drainDirect(transport, second);
    const other = request({
      identity: { ...first.identity!, sessionId: "other", runId: "other-run" },
    });
    await drainDirect(transport, other);

    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.sent[1]).toMatchObject({
      previous_response_id: "resp_1",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    });
    transport.close();
  });

  test("recovers a missing in-memory continuation once with full context", async () => {
    const socket = new FakeSocket((body, target) => {
      if (target.sent.length === 1) target.message(completed("resp_1"));
      else if (body.previous_response_id) {
        target.message({
          type: "error",
          status: 400,
          error: { code: "previous_response_not_found", message: "gone" },
        });
      } else target.message(completed("resp_2"));
    });
    const transport = new OpenAiResponsesWebSocketTransport({ websocketFactory: () => socket });
    const first = request();
    await drainDirect(transport, first);
    await drainDirect(
      transport,
      request({
        identity: { ...first.identity!, runId: "run-2" },
        context: [
          ...first.context,
          { type: "assistant_message", text: "done" },
          {
            type: "user_message",
            text: "again",
            model: { connectionId: "openai", modelId: "gpt-5.6" },
            reasoning: "high",
          },
        ],
      }),
    );
    expect(socket.sent).toHaveLength(3);
    expect(socket.sent[1]).toHaveProperty("previous_response_id", "resp_1");
    expect(socket.sent[2]).not.toHaveProperty("previous_response_id");
    transport.close();
  });

  test("falls back to pi-ai SSE only on a pre-output drop", async () => {
    const partial: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "fallback" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    const sse = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const events: AssistantMessageEvent[] = [
          { type: "text_delta", contentIndex: 0, delta: "fallback", partial },
          { type: "done", reason: "stop", message: partial },
        ];
        for (const event of events) stream.push(event);
        stream.end();
      });
      return stream;
    });
    const transport = new PiAiTransport({
      resolve: () => ({ ...route, label: "OpenAI", protocol: "openai-responses" }),
      openAiWebSocketFactory: () =>
        new FakeSocket((_body, target) => target.emit("close", 1006, Buffer.alloc(0))),
      streams: { "openai-responses": sse },
    });
    const output: ModelStreamEvent[] = [];
    for await (const event of transport.stream(request(), new AbortController().signal))
      output.push(event);
    expect(sse).toHaveBeenCalledOnce();
    expect(output).toContainEqual({ type: "text_delta", delta: "fallback" });
    transport.close();
  });

  test("never replays through SSE after forwarding output, and abort closes the socket", async () => {
    const sse = vi.fn();
    const dropped = new PiAiTransport({
      resolve: () => ({ ...route, label: "OpenAI", protocol: "openai-responses" }),
      openAiWebSocketFactory: () =>
        new FakeSocket((_body, target) => {
          target.message({ type: "response.output_text.delta", delta: "visible" });
          queueMicrotask(() => target.emit("close", 1006, Buffer.alloc(0)));
        }),
      streams: { "openai-responses": sse as never },
    });
    await expect(async () => {
      for await (const _event of dropped.stream(request(), new AbortController().signal))
        void _event;
    }).rejects.toBeInstanceOf(ModelTransportError);
    expect(sse).not.toHaveBeenCalled();
    dropped.close();

    const controller = new AbortController();
    let abortSocket: FakeSocket | undefined;
    const aborted = new OpenAiResponsesWebSocketTransport({
      websocketFactory: () => (abortSocket = new FakeSocket(() => controller.abort())),
    });
    await expect(drainDirect(aborted, request(), controller.signal)).rejects.toMatchObject({
      normalized: { code: "aborted" },
    });
    expect(abortSocket?.readyState).toBe(3);
    aborted.close();
  });

  test("TTFT forwarding and 100-turn connection reuse stay bounded", async () => {
    let connections = 0;
    const transport = new OpenAiResponsesWebSocketTransport({
      websocketFactory: () => {
        connections += 1;
        return new FakeSocket((_body, target) => {
          target.message({ type: "response.output_text.delta", delta: "x" });
          target.message(completed(`resp_${target.sent.length}`));
        });
      },
    });
    const started = performance.now();
    let current = request();
    for (let index = 0; index < 100; index += 1) {
      const result = await drainDirect(transport, current);
      expect(result.events[0]).toEqual({ type: "text_delta", delta: "x" });
      current = request({
        identity: { ...current.identity!, runId: `run-${index + 1}` },
        context: [
          ...current.context,
          { type: "assistant_message", text: "x" },
          {
            type: "user_message",
            text: `next-${index}`,
            model: { connectionId: "openai", modelId: "gpt-5.6" },
            reasoning: "high",
          },
        ],
      });
    }
    expect(connections).toBe(1);
    expect(performance.now() - started).toBeLessThan(1_000);
    transport.close();
  });
});
