import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  createDraftSessionSendState,
  createPromptSendState,
  createTurnRunStart,
  nextNamingRequestId,
} from "./agent-send-state";

describe("createTurnRunStart", () => {
  test("maps agent send selection into a running turn", () => {
    const turnRun = createTurnRunStart({
      sessionId: "session-1",
      selection: {
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
      },
      startedAt: 123,
      turnId: "turn-1",
    });

    expect(turnRun).toEqual({
      id: "turn-1",
      sessionID: "session-1",
      startedAt: 123,
      status: "running",
      providerID: "openai",
      modelID: "gpt-5",
      thinkingLevel: "high",
    });
  });
});

describe("createPromptSendState", () => {
  test("reuses one turn id for turn run and prompt submission", () => {
    const state = createPromptSendState({
      sessionId: "session-1",
      text: "hello",
      selection: {},
      startedAt: 123,
      turnId: "turn-1",
    });

    expect(state).toEqual({
      turnRun: {
        id: "turn-1",
        sessionID: "session-1",
        startedAt: 123,
        status: "running",
        providerID: undefined,
        modelID: undefined,
        thinkingLevel: undefined,
      },
      promptSubmitted: {
        id: "turn-1",
        sessionID: "session-1",
        text: "hello",
        createdAt: 123,
      },
    });
  });
});

describe("createDraftSessionSendState", () => {
  test("adds title, chat meta, and optional turn run", () => {
    const state = createDraftSessionSendState({
      session: { id: "session-1", directory: "/repo", title: null } as never,
      selection: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "high" },
      trackTurnRun: true,
      isChatDirectory: true,
      startedAt: 123,
      turnId: "turn-1",
    });

    expect(state.titledSession).toMatchObject({ id: "session-1", title: "Untitled" });
    expect(state.sessionMeta).toEqual({ originMode: "chat", assignedProjectDir: null });
    expect(state.turnRun).toMatchObject({
      id: "turn-1",
      sessionID: "session-1",
      providerID: "openai",
      modelID: "gpt-5",
      thinkingLevel: "high",
    });
  });
});

describe("nextNamingRequestId", () => {
  test("increments from undefined", () => {
    expect(nextNamingRequestId(undefined)).toBe(1);
  });

  test("increments from an existing request id", () => {
    expect(nextNamingRequestId(4)).toBe(5);
  });
});
