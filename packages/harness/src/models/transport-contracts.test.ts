import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { createOpenGuiHarness } from "../open-gui-harness.ts";
import { SequenceIdGenerator } from "../test/index.ts";
import type { ModelRequest, ModelStreamEvent, ModelTransport } from "./transport.ts";
import {
  createModelCachePolicy,
  deriveModelConnectionKey,
  deriveModelCacheKey,
  normalizeModelError,
  redactProviderText,
} from "./transport.ts";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    identity: {
      hostId: "host-a",
      sessionId: "session-a",
      runId: "run-a",
      principalId: "user:ada",
    },
    projectDirectory: "/project",
    systemPrompt: "stable prompt",
    tools: ["read"],
    context: [
      {
        type: "user_message",
        text: "hello",
        model: { connectionId: "backend-a", modelId: "model-a" },
        reasoning: "none",
      },
    ],
    cache: createModelCachePolicy({
      systemPrompt: "stable prompt",
      tools: ["read"],
      toolSchemas: [{ name: "read", schema: { type: "object" } }],
      permissionScope: { roots: ["/project"], write: false },
      skillRevisions: ["skill-rev-a"],
    }),
    ...overrides,
  };
}

describe("durable transport cache contract", () => {
  test("has a stable golden key without exposing identity or credentials", () => {
    const key = deriveModelCacheKey(request(), {
      backendId: "backend-a",
      upstreamModelId: "model-a",
      protocol: "openai-responses",
    });
    expect(key).toMatchInlineSnapshot(`"ogc_64b4117d8d9b5cc0cc4df57e3d4d99493245cfea02b9949d"`);
    expect(key).not.toMatch(/host-a|session-a|ada|backend-a|model-a/);
  });

  test("has stable socket affinity across replay generations and isolates model routes", () => {
    const route = {
      backendId: "backend-a",
      upstreamModelId: "model-a",
      protocol: "codex-responses" as const,
    };
    const initial = request();
    const regenerated = request({ cache: { ...initial.cache!, generation: "next-generation" } });
    expect(deriveModelConnectionKey(initial, route)).toMatchInlineSnapshot(
      `"ogw_d1bcedb1236b52f2107aca08fe4f086d71a9552df1f619a1"`,
    );
    expect(deriveModelConnectionKey(regenerated, route)).toBe(
      deriveModelConnectionKey(initial, route),
    );
    expect(deriveModelConnectionKey(initial, { ...route, upstreamModelId: "model-b" })).not.toBe(
      deriveModelConnectionKey(initial, route),
    );
  });

  test.each([
    ["host", { hostId: "host-b" }],
    ["session", { sessionId: "session-b" }],
    ["principal", { principalId: "user:grace" }],
  ])("isolates the key by %s", (_name, identity) => {
    const baseline = request();
    const changed = request({ identity: { ...baseline.identity!, ...identity } });
    const route = {
      backendId: "backend-a",
      upstreamModelId: "model-a",
      protocol: "openai-responses" as const,
    };
    expect(deriveModelCacheKey(changed, route)).not.toBe(deriveModelCacheKey(baseline, route));
  });

  test.each([
    [
      "backend route",
      { backendId: "backend-b", upstreamModelId: "model-a", protocol: "openai-responses" as const },
    ],
    [
      "upstream model",
      { backendId: "backend-a", upstreamModelId: "model-b", protocol: "openai-responses" as const },
    ],
    [
      "protocol",
      {
        backendId: "backend-a",
        upstreamModelId: "model-a",
        protocol: "anthropic-messages" as const,
      },
    ],
  ])("invalidates on %s retargeting", (_name, changedRoute) => {
    const baselineRoute = {
      backendId: "backend-a",
      upstreamModelId: "model-a",
      protocol: "openai-responses" as const,
    };
    expect(deriveModelCacheKey(request(), changedRoute)).not.toBe(
      deriveModelCacheKey(request(), baselineRoute),
    );
  });

  test.each([
    ["prompt", { systemPrompt: "changed" }],
    ["tool schema", { toolSchemas: [{ name: "read", schema: { required: ["path"] } }] }],
    ["permissions", { permissionScope: { roots: ["/other"], write: true } }],
    ["pinned Skill revision", { skillRevisions: ["skill-rev-b"] }],
    ["compaction", { compactionId: "entry-compacted" }],
  ])("changes generation when %s changes", (_name, changed) => {
    const base = {
      systemPrompt: "stable",
      tools: ["read"] as const,
      toolSchemas: [{ name: "read", schema: {} }],
      permissionScope: { roots: ["/project"], write: false },
      skillRevisions: ["skill-rev-a"],
    };
    expect(createModelCachePolicy({ ...base, ...changed }).generation).not.toBe(
      createModelCachePolicy(base).generation,
    );
  });

  test("redacts credentials and normalizes abort independently of adapters", () => {
    const secret = "sk-private-123456";
    expect(redactProviderText(`Bearer ${secret}; api_key=${secret}`, [secret])).not.toContain(
      secret,
    );
    const controller = new AbortController();
    controller.abort();
    expect(normalizeModelError(new Error(`failed with ${secret}`), controller.signal)).toEqual({
      code: "aborted",
      message: "Model request was aborted",
      retryable: false,
    });
  });

  test.each([
    ["You have hit your ChatGPT usage limit (pro plan).", "rate_limit"],
    ["WebSocket connection closed unexpectedly", "provider_unavailable"],
    ["TypeError: fetch failed", "provider_unavailable"],
  ])("normalizes transient provider failure: %s", (message, code) => {
    expect(normalizeModelError(new Error(message))).toMatchObject({ code, retryable: true });
  });
});

test("provider replay metadata survives restart and deltas remain ordered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opengui-transport-durable-"));
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(join(project, "README.md"), "fixture");
  const replay = {
    items: [{ type: "reasoning" as const, id: "rs_1", encryptedContent: "encrypted-reasoning" }],
  };
  const first: ModelTransport = {
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", delta: "A" };
      yield { type: "text_delta", delta: "B" };
      yield {
        type: "completed",
        response: {
          responseId: "resp_1",
          provider: "fixture",
          api: "openai-responses",
          model: "fixture-model",
          protocol: "openai-responses",
          usage: { input: 10, output: 2, cacheRead: 8, cacheWrite: 1, total: 21 },
          stopReason: "stop",
          replay,
          cache: {
            key: input.cache?.key,
            generation: input.cache?.generation ?? "legacy",
            readTokens: 8,
            writeTokens: 1,
          },
          timing: {
            startedAt: new Date(0).toISOString(),
            firstDeltaMs: 1,
            completedMs: 2,
            attempts: 1,
          },
        },
      };
    },
  };
  const harness = createOpenGuiHarness({
    dataDirectory: directory,
    hostId: "host-durable",
    model: first,
    ids: new SequenceIdGenerator(),
  });
  const session = await harness.createSession({
    projectDirectory: project,
    model: { connectionId: "fixture", modelId: "fixture-model" },
    reasoning: "none",
  });
  const sessionId = (await session.read()).id;
  const live: string[] = [];
  for await (const event of session.run({ text: "first" })) {
    if (event.type === "assistant_delta") live.push(event.delta);
  }
  expect(live).toEqual(["A", "B"]);
  expect((await session.read()).entries).toContainEqual(
    expect.objectContaining({
      kind: "provider_response",
      payload: expect.objectContaining({
        response: expect.objectContaining({ responseId: "resp_1" }),
      }),
    }),
  );
  await harness.close();

  const requests: ModelRequest[] = [];
  const second: ModelTransport = {
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      requests.push(structuredClone(input));
      yield { type: "text_delta", delta: "C" };
      yield { type: "completed" };
    },
  };
  const restarted = createOpenGuiHarness({
    dataDirectory: directory,
    hostId: "host-durable",
    model: second,
    ids: new SequenceIdGenerator(100),
  });
  const reopened = await restarted.openSession(sessionId);
  for await (const _event of reopened.run({ text: "second" })) {
    // drain
  }
  expect(requests[0]?.context).toContainEqual(
    expect.objectContaining({ type: "assistant_message", text: "AB", replay }),
  );
  await restarted.close();
});
