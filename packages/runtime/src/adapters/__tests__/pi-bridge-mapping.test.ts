import { describe, expect, test } from "vite-plus/test";
import {
  createAssistantInfo,
  createBundle,
  inferPiSessionModelFromManager,
  makeReasoningPartId,
  normalizePiSession,
  syncAssistantParts,
} from "../pi-bridge-mapping.ts";

describe("pi-bridge-mapping", () => {
  test("normalizePiSession tags harness and frontend id", () => {
    const session = normalizePiSession(
      { id: "raw-1", cwd: "/repo", name: "Hello" },
      { workspaceId: "local", directory: "/repo" },
    );
    expect(session.id).toBe("pi:raw-1");
    expect(session._harnessId).toBe("pi");
    expect(session.directory).toBeTruthy();
  });

  test("inferPiSessionModelFromManager reads branch model_change", () => {
    const model = inferPiSessionModelFromManager({
      getBranch: () => [{ type: "model_change", provider: "nvidia", modelId: "gpt" }],
    });
    expect(model).toEqual({ providerID: "nvidia", id: "gpt" });
  });

  test("#130 one reasoning part per thinking block across syncAssistantParts calls", () => {
    const sessionId = "pi:s1";
    const messageId = "pi:stream:s1:assistant:0";
    const bundle = createBundle(
      createAssistantInfo({
        sessionId,
        messageId,
        timestamp: 10,
        directory: "/repo",
        createdAt: 100,
      }),
      [],
    );
    const message = {
      content: [
        { type: "thinking", thinking: "Step one" },
        { type: "text", text: "Hello" },
      ],
    };
    const times = new Map<number, { start: number; end?: number }>();
    times.set(0, { start: 100, end: 150 });

    syncAssistantParts(bundle, message, times);
    expect(bundle.parts).toHaveLength(2);
    expect(bundle.parts[0]).toMatchObject({
      type: "reasoning",
      id: makeReasoningPartId(messageId, 0),
      text: "Step one",
    });
    expect(bundle.parts[1]).toMatchObject({ type: "text", text: "Hello" });

    message.content[0] = { type: "thinking", thinking: "Step one extended" };
    syncAssistantParts(bundle, message, times);
    const reasoningParts = bundle.parts.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(1);
    expect(reasoningParts[0]?.text).toBe("Step one extended");
  });

  test("thinking block uses stable reasoning part id by index not content index", () => {
    const messageId = "m1";
    const bundle = createBundle(
      createAssistantInfo({ sessionId: "pi:s", messageId, timestamp: 1, createdAt: 1 }),
      [],
    );
    syncAssistantParts(bundle, {
      content: [
        { type: "thinking", thinking: "a" },
        { type: "thinking", thinking: "b" },
      ],
    });
    expect(bundle.parts.map((p) => p.id)).toEqual([
      makeReasoningPartId(messageId, 0),
      makeReasoningPartId(messageId, 1),
    ]);
  });
});
