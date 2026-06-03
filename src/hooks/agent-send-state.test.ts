import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createPromptSendStartActions } from "@/hooks/agent-send-state";

describe("createPromptSendStartActions", () => {
  test("captures the direct Agent send state transition behind one interface", () => {
    expect(
      createPromptSendStartActions({
        sessionId: "opencode:raw-1",
        text: "ship it",
        selection: {
          model: { providerID: "anthropic", modelID: "claude-sonnet" },
          agent: "build",
          variant: "think",
        },
        startedAt: 123,
        turnId: "turn-1",
      }),
    ).toEqual([
      { type: "SET_BUSY", payload: true },
      {
        type: "TURN_RUN_STARTED",
        payload: {
          id: "turn-1",
          sessionID: "opencode:raw-1",
          startedAt: 123,
          status: "running",
          providerID: "anthropic",
          modelID: "claude-sonnet",
          thinkingLevel: "think",
        },
      },
      {
        type: "PROMPT_SUBMITTED",
        payload: {
          id: "turn-1",
          sessionID: "opencode:raw-1",
          text: "ship it",
          createdAt: 123,
        },
      },
    ]);
  });
});
