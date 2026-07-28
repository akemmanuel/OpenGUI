import { describe, expect, test, vi } from "vite-plus/test";
import { CodexResponsesTransport, codexInput, codexResponseEvents } from "./codex-responses.ts";

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

  test("surfaces malformed tool arguments for normal tool validation", () => {
    expect(
      codexResponseEvents({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call-1", name: "write", arguments: '{"path"' },
      }),
    ).toEqual([
      {
        type: "tool_call",
        id: "call-1",
        name: "write",
        input: { raw: '{"path"' },
      },
    ]);
  });
});

describe("codexInput", () => {
  test("injects image tool results as Responses image content", () => {
    expect(
      codexInput([
        {
          type: "tool_result",
          toolCallId: "call-image",
          name: "read",
          output: {
            content: "Read image file [image/png]",
            attachments: [{ type: "image", mimeType: "image/png", data: "abc123" }],
          },
        },
      ]),
    ).toEqual([
      {
        type: "function_call_output",
        call_id: "call-image",
        output: [
          { type: "input_text", text: "Read image file [image/png]" },
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,abc123",
          },
        ],
      },
    ]);
  });
});

describe("CodexResponsesTransport", () => {
  const request = {
    systemPrompt: "help",
    projectDirectory: "/project",
    context: [
      {
        type: "user_message" as const,
        text: "hello",
        model: { connectionId: "supergrok", modelId: "grok-build" },
        reasoning: "medium" as const,
      },
    ],
  };

  test("assembles multiple Responses tool calls from argument deltas and done events", async () => {
    const wire = [
      { type: "response.output_text.done", text: "Ready." },
      { type: "response.reasoning_summary_text.done", text: "Use both tools." },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "item-a", type: "function_call", call_id: "call-a", name: "read" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "item-a",
        delta: '{"path":"a',
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "item-a",
        arguments: '{"path":"a.txt"}',
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "item-a",
          type: "function_call",
          call_id: "call-a",
          name: "read",
          arguments: '{"path":"a.txt"}',
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "item-b",
          type: "function_call",
          call_id: "call-b",
          name: "read",
          arguments: '{"path":"b.txt"}',
        },
      },
      { type: "response.completed", response: { output: [] } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join("");
    const transport = new CodexResponsesTransport({
      getCredential: async () => ({ accessToken: "secret", accountId: "" }),
      fetchImpl: async () => new Response(wire),
    });

    const events = [];
    for await (const event of transport.stream(request, new AbortController().signal))
      events.push(event);

    expect(events).toEqual([
      { type: "text_delta", delta: "Ready." },
      { type: "reasoning_delta", delta: "Use both tools." },
      { type: "tool_call", id: "call-a", name: "read", input: { path: "a.txt" } },
      { type: "tool_call", id: "call-b", name: "read", input: { path: "b.txt" } },
      { type: "completed" },
    ]);
  });

  test("forces exactly one credential refresh and retry after an inference 401", async () => {
    const credentials: boolean[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response("data: [DONE]\n\n"));
    const transport = new CodexResponsesTransport({
      getCredential: async (force) => {
        credentials.push(Boolean(force));
        return { accessToken: force ? "rotated-secret" : "old-secret", accountId: "" };
      },
      fetchImpl,
    });

    const events = [];
    for await (const event of transport.stream(request, new AbortController().signal))
      events.push(event);

    expect(credentials).toEqual([false, true]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ type: "completed" }]);
  });

  test.each([
    [400, "rejected the request"],
    [403, "entitlement and organization policy"],
    [404, "endpoint or model"],
    [429, "rate limit"],
    [503, "temporarily unavailable"],
  ])(
    "classifies HTTP %s without leaking response bodies or credentials",
    async (status, message) => {
      const transport = new CodexResponsesTransport({
        requestLabel: "Grok Build",
        getCredential: async () => ({ accessToken: "never-print-this", accountId: "" }),
        fetchImpl: async () => new Response("upstream secret details", { status }),
      });
      const consume = async () => {
        for await (const _event of transport.stream(request, new AbortController().signal)) {
          // Drain.
        }
      };
      await expect(consume()).rejects.toThrow(message);
      await expect(consume()).rejects.not.toThrow(/never-print-this|upstream secret details/);
    },
  );

  test("rejects incomplete and malformed streams with safe diagnostics", async () => {
    for (const [wire, expected] of [
      ['data: {"type":"response.incomplete"}\n\n', "response was incomplete"],
      ["data: {not-json}\n\n", "malformed event stream"],
    ] as const) {
      const transport = new CodexResponsesTransport({
        getCredential: async () => ({ accessToken: "secret", accountId: "" }),
        fetchImpl: async () => new Response(wire),
      });
      const consume = async () => {
        for await (const _event of transport.stream(request, new AbortController().signal)) {
          // Drain.
        }
      };
      await expect(consume()).rejects.toThrow(expected);
    }
  });

  test("propagates abort while reading a stream", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta"'));
      },
    });
    const transport = new CodexResponsesTransport({
      getCredential: async () => ({ accessToken: "secret", accountId: "" }),
      fetchImpl: async () => new Response(body),
    });
    const iterator = transport.stream(request, controller.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    controller.abort(new DOMException("Aborted", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("decodes multibyte SSE split across CRLF chunks and dispatches the final frame at EOF", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"response.output_text.delta","delta":"café 🧪"}\r\n\r\ndata: [DONE]',
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const end of [63, 66, 68, bytes.length]) {
          const start = end === 63 ? 0 : [63, 66, 68][[63, 66, 68, bytes.length].indexOf(end) - 1];
          controller.enqueue(bytes.slice(start, end));
        }
        controller.close();
      },
    });
    const transport = new CodexResponsesTransport({
      getCredential: async () => ({ accessToken: "token", accountId: "account" }),
      fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch,
    });

    const events = [];
    for await (const event of transport.stream(
      {
        systemPrompt: "help",
        projectDirectory: "/project",
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
    ))
      events.push(event);

    expect(events).toEqual([{ type: "text_delta", delta: "café 🧪" }, { type: "completed" }]);
  });

  test("retries without image content when a Responses model rejects images", async () => {
    const bodies: string[] = [];
    const transport = new CodexResponsesTransport({
      getCredential: async () => ({ accessToken: "token", accountId: "account" }),
      fetchImpl: (async (_url, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : "");
        return bodies.length === 1
          ? new Response("invalid image input", { status: 400 })
          : new Response("data: [DONE]", { status: 200 });
      }) as typeof fetch,
    });

    const events = [];
    for await (const event of transport.stream(
      {
        systemPrompt: "help",
        projectDirectory: "/project",
        context: [
          {
            type: "user_message",
            text: "inspect",
            model: { connectionId: "codex", modelId: "text-only" },
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

  test("rejects a Responses stream that closes before completion", async () => {
    const transport = new CodexResponsesTransport({
      getCredential: async () => ({ accessToken: "token", accountId: "account" }),
      fetchImpl: (async () =>
        new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
          status: 200,
        })) as typeof fetch,
    });
    const consume = async () => {
      for await (const _event of transport.stream(
        {
          systemPrompt: "help",
          projectDirectory: "/project",
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
      tools: Array<{ name: string; description: string; parameters: { required?: string[] } }>;
    };
    expect(body.tools.map((tool) => tool.name)).toEqual(["read", "write", "edit"]);
    expect(body.tools[0]?.description).toContain("Read a text file");
    expect(body.tools[0]?.parameters.required).toEqual(["path"]);
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
