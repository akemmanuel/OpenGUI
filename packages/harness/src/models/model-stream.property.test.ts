import { describe, expect, test } from "vite-plus/test";
import { bytePartitions } from "../test/seeded.ts";
import { CodexResponsesTransport } from "./codex-responses.ts";
import { OpenAiChatTransport } from "./openai-chat.ts";
import type { ModelRequest, ModelStreamEvent, ModelTransport } from "./transport.ts";

const request: ModelRequest = {
  systemPrompt: "test",
  projectDirectory: "/project",
  context: [
    {
      type: "user_message",
      text: "hello",
      model: { connectionId: "fixture", modelId: "fixture-model" },
      reasoning: "none",
    },
  ],
};

function response(wire: string, seed: number) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of bytePartitions(wire, seed)) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

async function drain(model: ModelTransport) {
  const events: ModelStreamEvent[] = [];
  for await (const event of model.stream(request, new AbortController().signal)) events.push(event);
  return events;
}

describe("seeded model stream chunk-boundary properties", () => {
  test("OpenAI chat preserves Unicode and fragmented tool JSON across 100 byte partitions", async () => {
    const wire = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "🙂 café 漢" } }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "write", arguments: '{"path":"é.' } }] } }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'txt","content":"🧪"}' } }] } }] })}\n`,
      "data: [DONE]\n",
    ].join("");
    for (let seed = 1; seed <= 100; seed += 1) {
      const model = new OpenAiChatTransport({ fetchImpl: async () => response(wire, seed) });
      model.setConnections([
        {
          id: "fixture",
          label: "Fixture",
          baseUrl: "https://fixture.test/v1",
          modelIds: ["fixture-model"],
        },
      ]);
      expect(await drain(model), `seed ${seed}`).toEqual([
        { type: "text_delta", delta: "🙂 café 漢" },
        { type: "tool_call", id: "call", name: "write", input: { path: "é.txt", content: "🧪" } },
        { type: "completed" },
      ]);
    }
  });

  test("Codex responses preserves Unicode across 100 byte partitions", async () => {
    const wire = `${[
      { type: "response.output_text.delta", delta: "🙂 café 漢字" },
      { type: "response.completed", response: { output: [] } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join("")}data: [DONE]\r\n\r\n`;
    for (let seed = 101; seed <= 200; seed += 1) {
      const model = new CodexResponsesTransport({
        getCredential: async () => ({ accessToken: "fixture", accountId: "account" }),
        fetchImpl: async () => response(wire, seed),
      });
      expect(await drain(model), `seed ${seed}`).toEqual([
        { type: "text_delta", delta: "🙂 café 漢字" },
        { type: "completed" },
      ]);
    }
  });
});
