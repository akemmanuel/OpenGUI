// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  selectedModel: { providerID: "openai", modelID: "gpt-4.1" } as null | {
    providerID: string;
    modelID: string;
  },
  submit: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ModelSelector", () => ({ ModelSelector: () => <button>model</button> }));
vi.mock("@/components/ReasoningEffortSelector", () => ({
  ReasoningEffortSelector: () => <button>reasoning</button>,
}));
vi.mock("@/components/PromptAddMenu", () => ({
  PromptAddMenu: ({ disabled }: { disabled: boolean }) => (
    <button disabled={disabled}>add file</button>
  ),
}));
vi.mock("@/components/PromptContextStatus", () => ({
  PromptContextStatus: ({ contextPercent }: { contextPercent: number }) => (
    <span>context {contextPercent}</span>
  ),
}));
vi.mock("@/components/PromptImageMentions", () => ({
  PromptImageMentions: () => null,
  usePromptImages: () => [],
}));
vi.mock("@/components/FileMentionPopover", () => ({ FileMentionPopover: () => null }));
vi.mock("@/hooks/use-agent-backend", () => ({
  useBackendCapabilities: () => ({ commands: false, agents: false }),
}));
vi.mock("@/features/session-transcript/active-session-transcript-provider", () => ({
  useActiveTranscriptPromptHistory: () => [],
}));
vi.mock("@/hooks/use-prompt-files", () => ({
  usePromptFiles: () => ({
    isDragging: false,
    isUploading: false,
    uploadProgress: null,
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
    handleFileChange: vi.fn(),
    handlePaste: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({
    setAgent: vi.fn(),
    sendCommand: vi.fn(),
    findFiles: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
    ensureSessionSkills: vi.fn(),
    toggleSessionSkill: vi.fn(),
    setSessionDraft: vi.fn(),
    clearSessionDraft: vi.fn(),
  }),
  useModelState: () => ({
    commands: [],
    agents: [],
    selectedAgent: null,
    selectedModel: fixture.selectedModel,
  }),
  useSessionState: () => ({
    sessions: [{ id: "s1", directory: "/project" }],
    activeSessionId: "s1",
    activeTargetDirectory: "/project",
    sessionDrafts: {},
    enabledSkillNames: [],
    skillsLocked: false,
  }),
  useWorkspaceState: () => ({
    activeWorkspace: { isLocal: true },
    activeWorkspaceId: "local",
    workspaceServerUrl: null,
  }),
}));

import { PromptBox } from "./PromptBox";

describe("PromptBox interactions", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  test("submits Enter but never submits the Enter used to confirm IME composition", async () => {
    render(<PromptBox queueMode="queue" onQueueModeChange={vi.fn()} onSubmit={fixture.submit} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "こんにちは");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", isComposing: true });
    expect(fixture.submit).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(fixture.submit).toHaveBeenCalledWith("こんにちは", undefined);
  });

  test("keeps disabled sessions read-only and cannot submit", async () => {
    render(
      <PromptBox
        disabled
        queueMode="queue"
        onQueueModeChange={vi.fn()}
        onSubmit={fixture.submit}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("prompt.selectOrCreateSession");
    expect(screen.getByRole("button", { name: "add file" }).hasAttribute("disabled")).toBe(true);
  });

  test("shows running controls, queue modes, context, and stops the run", async () => {
    const onQueueModeChange = vi.fn();
    render(
      <PromptBox
        isLoading
        queueMode="after-part"
        onQueueModeChange={onQueueModeChange}
        onSubmit={fixture.submit}
        onStop={fixture.stop}
        contextInfo={{
          percent: 73,
          tokens: 1,
          cost: 2,
          contextLimit: 3,
          isEstimated: false,
        }}
      />,
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe(
      "prompt.steerDirection",
    );
    expect(screen.getByText("context 73")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "prompt.queue" }));
    await userEvent.click(screen.getByRole("button", { name: "prompt.stopGenerating" }));
    expect(onQueueModeChange).toHaveBeenCalledWith("queue");
    expect(fixture.stop).toHaveBeenCalledOnce();
  });

  test("requires a selected model before enabling send", async () => {
    fixture.selectedModel = null;
    const { unmount } = render(
      <PromptBox queueMode="queue" onQueueModeChange={vi.fn()} onSubmit={fixture.submit} />,
    );
    await userEvent.type(screen.getByRole("textbox"), "hello");
    expect(
      screen.getByRole("button", { name: "prompt.sendMessage" }).hasAttribute("disabled"),
    ).toBe(true);
    unmount();
    fixture.selectedModel = { providerID: "openai", modelID: "gpt-4.1" };
  });
});
