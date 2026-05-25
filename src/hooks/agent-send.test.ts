import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  resolveAgentSendSelection,
  sendCommandToAgent,
  sendPromptToAgent,
  startDraftSessionAgentSend,
} from "./agent-send";

describe("resolveAgentSendSelection", () => {
  test("uses explicit override variant before fallback resolution", () => {
    const selection = resolveAgentSendSelection(
      {
        selectedModel: { providerID: "openai", modelID: "gpt-5" },
        selectedAgent: "reviewer",
        variantSelections: { "openai/gpt-5": "high" },
        agents: [{ name: "reviewer", variant: "low" } as never],
      },
      { variant: "max" },
    );

    expect(selection).toEqual({
      model: { providerID: "openai", modelID: "gpt-5" },
      agent: "reviewer",
      variant: "max",
    });
  });
});

describe("startDraftSessionAgentSend", () => {
  test("omits title for claude-code draft send", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const startSession = async (input: Record<string, unknown>) => {
      calls.push(input);
      return { id: "session-1", directory: input.directory };
    };

    await startDraftSessionAgentSend({
      runtime: { startSession, sendCommand: async () => undefined } as never,
      backendId: "claude-code",
      workspaceId: "workspace-1",
      directory: "/repo",
      text: "hello",
      selection: {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: undefined,
      directory: "/repo",
      workspaceId: "workspace-1",
    });
  });
});

describe("sendPromptToAgent", () => {
  test("forwards backend target and backend id from the session", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const prompt = async (input: Record<string, unknown>) => {
      calls.push(input);
    };

    const result = await sendPromptToAgent({
      sessions: { prompt } as never,
      session: {
        id: "pi:session-1",
        directory: "/backend",
        _projectDir: "/repo",
        _workspaceId: "workspace-1",
        _backendId: "pi",
      } as never,
      sessionId: "pi:session-1",
      text: "hello",
      selection: { agent: "reviewer" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId: "pi:session-1",
      text: "hello",
      agent: "reviewer",
      backendId: "pi",
      target: { directory: "/repo", workspaceId: "workspace-1" },
    });
    expect(result).toEqual({
      projectTarget: { directory: "/repo", workspaceId: "workspace-1" },
    });
  });
});

describe("sendCommandToAgent", () => {
  test("forwards project target to runtime sendCommand", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sendCommand = async (input: Record<string, unknown>) => {
      calls.push(input);
    };

    const result = await sendCommandToAgent({
      runtime: { sendCommand } as never,
      session: {
        id: "session-1",
        directory: "/backend",
        _projectDir: "/repo",
        _workspaceId: "workspace-1",
      } as never,
      sessionId: "session-1",
      command: "review",
      args: "--all",
      selection: { variant: "high" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId: "session-1",
      command: "review",
      args: "--all",
      variant: "high",
      directory: "/repo",
      workspaceId: "workspace-1",
    });
    expect(result).toEqual({
      projectTarget: { directory: "/repo", workspaceId: "workspace-1" },
    });
  });
});
