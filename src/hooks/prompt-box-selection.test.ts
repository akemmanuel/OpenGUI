import { describe, expect, test } from "vite-plus/test";
import {
  hasPromptBoxSelectionForSend,
  isPromptBoxSelectionComplete,
  resolvePromptBoxHarnessId,
} from "@/hooks/prompt-box-selection";
import type { Session } from "@/hooks/agent-state-types";

function session(overrides: Partial<Session>): Session {
  return {
    id: "ses_test",
    title: "Test",
    time: { created: 1, updated: 1 },
    ...overrides,
  } as Session;
}

describe("prompt-box-selection", () => {
  test("resolvePromptBoxHarnessId prefers session harness when active", () => {
    expect(
      resolvePromptBoxHarnessId({
        activeSession: session({ _harnessId: "pi" }),
        activeTargetHarnessId: "codex",
        fallbackHarnessId: "opencode",
      }),
    ).toBe("pi");
  });

  test("resolvePromptBoxHarnessId uses active target for pending chat", () => {
    expect(
      resolvePromptBoxHarnessId({
        activeSession: null,
        activeTargetHarnessId: "codex",
        fallbackHarnessId: "opencode",
      }),
    ).toBe("codex");
  });

  test("resolvePromptBoxHarnessId falls back when no target", () => {
    expect(
      resolvePromptBoxHarnessId({
        activeSession: null,
        activeTargetHarnessId: null,
        fallbackHarnessId: "opencode",
      }),
    ).toBe("opencode");
  });

  test("isPromptBoxSelectionComplete requires harness and model", () => {
    expect(
      isPromptBoxSelectionComplete({
        harnessId: "pi",
        selectedModel: { providerID: "x", modelID: "y" },
      }),
    ).toBe(true);
    expect(isPromptBoxSelectionComplete({ harnessId: "pi", selectedModel: null })).toBe(false);
  });

  test("hasPromptBoxSelectionForSend requires model for resolved harness", () => {
    expect(
      hasPromptBoxSelectionForSend({
        activeSession: null,
        activeTargetHarnessId: "pi",
        fallbackHarnessId: "opencode",
        selectedModel: null,
      }),
    ).toBe(false);
    expect(
      hasPromptBoxSelectionForSend({
        activeSession: null,
        activeTargetHarnessId: "pi",
        fallbackHarnessId: "opencode",
        selectedModel: { providerID: "a", modelID: "b" },
      }),
    ).toBe(true);
  });
});
