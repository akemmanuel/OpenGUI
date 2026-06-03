import type { Agent } from "@opencode-ai/sdk/v2/client";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createPromptQueueEffect, decidePromptDispatch } from "./agent-prompt-routing";

describe("decidePromptDispatch", () => {
  test("sends direct when session is not busy", () => {
    const decision = decidePromptDispatch({
      isBusy: false,
      text: "hello",
      mode: "queue",
      selectedModel: null,
      selectedAgent: null,
      variantSelections: {},
      agents: [],
      now: 1,
      id: "prompt-1",
    });

    expect(decision).toEqual({ type: "send-direct" });
  });

  test("queues at the back for default queue mode", () => {
    const decision = decidePromptDispatch({
      isBusy: true,
      text: "hello",
      images: ["image-1"],
      mode: "queue",
      selectedModel: { providerID: "openai", modelID: "gpt-5" },
      selectedAgent: null,
      variantSelections: { "openai/gpt-5": "high" },
      agents: [],
      now: 123,
      id: "prompt-1",
    });

    expect(decision).toEqual({
      type: "queue",
      insertAt: "back",
      shouldAbort: false,
      shouldSetAfterPartPending: false,
      prompt: {
        id: "prompt-1",
        text: "hello",
        images: ["image-1"],
        createdAt: 123,
        model: { providerID: "openai", modelID: "gpt-5" },
        agent: undefined,
        variant: "high",
        mode: "queue",
      },
    });
  });

  test("queues at the front and aborts for interrupt mode", () => {
    const decision = decidePromptDispatch({
      isBusy: true,
      text: "stop and do this",
      mode: "interrupt",
      selectedModel: null,
      selectedAgent: null,
      variantSelections: {},
      agents: [],
      now: 1,
      id: "prompt-1",
    });

    expect(decision).toMatchObject({
      type: "queue",
      insertAt: "front",
      shouldAbort: true,
      shouldSetAfterPartPending: false,
    });
    expect(decision.type === "queue" ? decision.prompt.mode : null).toBe("interrupt");
    expect(decision.type === "queue" ? createPromptQueueEffect(decision).afterEnqueue : null).toBe(
      "abort",
    );
  });

  test("queues at the front and marks after-part pending", () => {
    const decision = decidePromptDispatch({
      isBusy: true,
      text: "steer",
      mode: "after-part",
      selectedModel: null,
      selectedAgent: null,
      variantSelections: {},
      agents: [],
      now: 1,
      id: "prompt-1",
    });

    expect(decision).toMatchObject({
      type: "queue",
      insertAt: "front",
      shouldAbort: false,
      shouldSetAfterPartPending: true,
    });
    expect(decision.type === "queue" ? decision.prompt.mode : null).toBe("after-part");
    expect(decision.type === "queue" ? createPromptQueueEffect(decision).afterEnqueue : null).toBe(
      "mark-after-part-pending",
    );
  });

  test("falls back to the selected agent variant when no explicit variant is set", () => {
    const decision = decidePromptDispatch({
      isBusy: true,
      text: "hello",
      mode: "queue",
      selectedModel: { providerID: "anthropic", modelID: "sonnet" },
      selectedAgent: "reviewer",
      variantSelections: {},
      agents: [{ name: "reviewer", variant: "high" } as Agent],
      now: 1,
      id: "prompt-1",
    });

    expect(decision).toMatchObject({
      type: "queue",
      prompt: {
        agent: "reviewer",
        variant: "high",
      },
    });
  });
});
