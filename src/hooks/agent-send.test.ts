import { describe, expect, test } from "vite-plus/test";
import {
  assertAgentSendSelection,
  resolveAgentSendSelection,
  sendCommandToAgent,
  sendPromptToAgent,
} from "./agent-send";

describe("assertAgentSendSelection", () => {
  test("throws when model is missing", () => {
    expect(() => assertAgentSendSelection({})).toThrow("PROMPT_BOX_SELECTION_INCOMPLETE");
  });
});

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
        _harnessId: "pi",
      } as never,
      sessionId: "pi:session-1",
      text: "hello",
      selection: {
        agent: "reviewer",
        model: { providerID: "openai", modelID: "gpt-4" },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId: "pi:session-1",
      text: "hello",
      agent: "reviewer",
      harnessId: "pi",
      target: { directory: "/repo", workspaceId: "workspace-1" },
    });
    expect(result).toEqual({
      projectTarget: { directory: "/repo", workspaceId: "workspace-1" },
    });
  });

  test("uses assigned project directory when a session was moved in the sidebar", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const prompt = async (input: Record<string, unknown>) => {
      calls.push(input);
    };

    await sendPromptToAgent({
      sessions: { prompt } as never,
      session: {
        id: "opencode:session-1",
        directory: "/home/tobias/Dokumente",
        _projectDir: "/home/tobias/Dokumente",
        _workspaceId: "workspace-1",
        _harnessId: "opencode",
      } as never,
      sessionMeta: {
        assignedProjectDir: "/home/tobias/Dokumente/Jutta Kürzl",
      },
      sessionId: "opencode:session-1",
      text: "where are you?",
      selection: {
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
      },
    });

    expect(calls[0]).toMatchObject({
      target: { directory: "/home/tobias/Dokumente/Jutta Kürzl", workspaceId: "workspace-1" },
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
      selection: {
        variant: "high",
        model: { providerID: "openai", modelID: "gpt-4" },
      },
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

  test("uses assigned project directory for commands after sidebar moves", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sendCommand = async (input: Record<string, unknown>) => {
      calls.push(input);
    };

    await sendCommandToAgent({
      runtime: { sendCommand } as never,
      session: {
        id: "opencode:session-1",
        directory: "/home/tobias/Dokumente",
        _projectDir: "/home/tobias/Dokumente",
        _workspaceId: "workspace-1",
      } as never,
      sessionMeta: {
        assignedProjectDir: "/home/tobias/Dokumente/Jutta Kürzl",
      },
      sessionId: "opencode:session-1",
      command: "review",
      args: "",
      selection: { model: { providerID: "openai", modelID: "gpt-4" } },
    });

    expect(calls[0]).toMatchObject({
      directory: "/home/tobias/Dokumente/Jutta Kürzl",
      workspaceId: "workspace-1",
    });
  });
});
