// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  role: "view" as "view" | "run" | "owner",
  sendPrompt: vi.fn(),
  abortSession: vi.fn(),
  startNewChat: vi.fn(),
  registerBack: vi.fn(),
  dismissSetup: vi.fn(),
}));

vi.mock("@/components/AppSidebar", () => ({
  AppSidebar: ({ onOpenSettings, onOpenChat }: any) => (
    <nav>
      <button onClick={onOpenSettings}>open settings</button>
      <button onClick={onOpenChat}>open chat</button>
    </nav>
  ),
}));
vi.mock("@/components/ConnectionPanel", () => ({
  SettingsView: ({ onBack }: any) => (
    <section>
      settings view<button onClick={onBack}>back</button>
    </section>
  ),
}));
vi.mock("@/components/MessageList", () => ({ MessageList: () => <div>transcript</div> }));
vi.mock("@/components/PromptBox", () => ({
  PromptBox: ({ disabled, onSubmit, onStop }: any) => (
    <div data-testid="prompt" data-disabled={String(disabled)}>
      <button onClick={() => onSubmit("hello", "send")}>send prompt</button>
      <button onClick={onStop}>stop run</button>
    </div>
  ),
}));
vi.mock("@/components/QueueList", () => ({ QueueList: () => <div>queue</div> }));
vi.mock("@/components/SetupWizard", () => ({ SetupWizard: () => null }));
vi.mock("@/components/TitleBar", () => ({ TitleBar: () => <header>title</header> }));
vi.mock("@/components/UpdateDialog", () => ({ UpdateDialog: () => null }));
vi.mock("@/features/identity/SessionShareDialog", () => ({ SessionShareDialog: () => null }));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarInset: ({ children }: any) => <main>{children}</main>,
  SidebarProvider: ({ children }: any) => <div>{children}</div>,
  useSidebar: () => ({ toggleSidebar: vi.fn() }),
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({
    sendPrompt: fixture.sendPrompt,
    abortSession: fixture.abortSession,
    startNewChat: fixture.startNewChat,
    getQueuedPrompts: () => [],
    removeFromQueue: vi.fn(),
    reorderQueue: vi.fn(),
    updateQueuedPrompt: vi.fn(),
    sendQueuedNow: vi.fn(),
    cycleVariant: vi.fn(),
    revertVariant: vi.fn(),
    revertToMessage: vi.fn(),
    unrevert: vi.fn(),
  }),
  useSessionState: () => ({
    sessions: [{ id: "s1", title: "Session", _accessRole: fixture.role }],
    activeSessionId: "s1",
    isBusy: false,
    activeTargetDirectory: "/project",
    sessionMeta: {},
    sessionErrors: {},
  }),
  useModelState: () => ({ providers: [], selectedModel: null, providerDefaults: {} }),
  useWorkspaceState: () => ({
    bootState: "ready",
    bootError: null,
    bootLogs: null,
    lastError: null,
    defaultChatDirectory: null,
    connections: { "/project": { state: "connected" } },
    workspaces: [{ id: "local" }],
    supportsMultipleWorkspaces: false,
  }),
}));
vi.mock("@/features/session-transcript/active-session-transcript-provider", () => ({
  useActiveTranscriptMessageOrder: () => [],
  useActiveTranscriptContextMessages: () => [],
}));
vi.mock("@/features/identity/identity-actor-context", () => ({
  useIdentityActor: () => ({ type: "user", id: "u1", role: "member" }),
}));
vi.mock("@/hooks/use-agent-backend", () => ({ useBackendCapabilities: () => ({ revert: false }) }));
vi.mock("@/hooks/use-update-check", () => ({ useUpdateCheck: () => ({ updateAvailable: false }) }));
vi.mock("@/hooks/use-context-info", () => ({ useContextInfo: () => null }));
vi.mock("@/features/app-shell/useAppKeyboardShortcuts", () => ({
  useAppKeyboardShortcuts: () => ({ queueMode: "send", setQueueMode: vi.fn() }),
}));
vi.mock("@/features/session/useActiveSessionQueue", () => ({
  useActiveSessionQueue: () => ({ queuedPrompts: [], queueHandlers: {} }),
}));
vi.mock("@/features/session/useChatSessionSurface", () => ({
  useChatSessionSurface: () => ({
    activeSession: { id: "s1", _accessRole: fixture.role },
    chatSurfaceState: { kind: "session" },
    hasConnectedProjects: true,
    showPromptBox: true,
  }),
}));
vi.mock("@/shell/useRegisterMobileBackHandler", () => ({
  useRegisterMobileBackHandler: fixture.registerBack,
}));

import { AppContent } from "./App";

describe("App shell orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.role = "view";
  });
  afterEach(cleanup);

  test("keeps view-only Sessions readable while permission-disabling the prompt", () => {
    render(<AppContent />);
    expect(screen.getByText("transcript")).toBeTruthy();
    expect(screen.getByTestId("prompt").dataset.disabled).toBe("true");
  });

  test("switches settings through sidebar, browser event, back action, and mobile registration", async () => {
    render(<AppContent onDismissSetup={fixture.dismissSetup} />);
    await userEvent.click(screen.getByText("open settings"));
    expect(screen.getByText("settings view")).toBeTruthy();
    expect(fixture.dismissSetup).toHaveBeenCalled();
    await userEvent.click(screen.getByText("back"));
    expect(screen.getByText("transcript")).toBeTruthy();
    fireEvent(window, new Event("opengui:open-settings"));
    expect(screen.getByText("settings view")).toBeTruthy();
    expect(fixture.registerBack).toHaveBeenCalled();
  });

  test("delegates prompt send and abort for runnable Sessions", async () => {
    fixture.role = "run";
    render(<AppContent />);
    expect(screen.getByTestId("prompt").dataset.disabled).toBe("false");
    await userEvent.click(screen.getByText("send prompt"));
    await userEvent.click(screen.getByText("stop run"));
    expect(fixture.sendPrompt).toHaveBeenCalledWith("hello", "send");
    expect(fixture.abortSession).toHaveBeenCalledOnce();
  });
});
