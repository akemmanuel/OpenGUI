// @vitest-environment happy-dom

import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ActionsContextValue } from "@/hooks/agent-contexts";
import {
  useActions,
  useModelState,
  useSessionState,
  useWorkspaceState,
} from "@/hooks/use-agent-state";
import { useActiveTranscriptContextMessages } from "@/features/session-transcript/active-session-transcript-provider";
import { IdentityActorProvider } from "@/features/identity/identity-actor-context";
import type { HostSessionSnapshot, HostSessionSummary } from "@/protocol/host-types";
import { STORAGE_KEYS } from "@/lib/constants";
import { makeProjectKey } from "@/hooks/agent-session-utils";

const host = vi.hoisted(() => ({
  health: vi.fn(),
  listModelConnections: vi.fn(),
  listProjects: vi.fn(),
  listSessions: vi.fn(),
  readSession: vi.fn(),
  subscribe: vi.fn(),
  registerProject: vi.fn(),
  unregisterProject: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  prompt: vi.fn(),
  abort: vi.fn(),
  setModel: vi.fn(),
  setReasoning: vi.fn(),
  findFiles: vi.fn(),
  listFollowUps: vi.fn(),
  removeFollowUp: vi.fn(),
  reorderFollowUps: vi.fn(),
  updateFollowUp: vi.fn(),
  sendFollowUpNow: vi.fn(),
}));
const persisted = vi.hoisted(() => ({ values: new Map<string, string>(), failWorkspaces: false }));

vi.mock("@/protocol/host-client", () => ({ createHostClient: () => host }));

import { HostProvider } from "./HostProvider";

const summary: HostSessionSummary = {
  id: "session-1",
  projectDirectory: "/project",
  title: "Existing session",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  status: "idle",
  accessRole: "owner",
};

const snapshot: HostSessionSnapshot = {
  ...summary,
  model: { connectionId: "provider-1", modelId: "model-1" },
  reasoning: "medium",
  entries: [
    {
      id: "entry-1",
      sessionId: "session-1",
      sequence: 1,
      kind: "user_message",
      payload: { text: "hydrated transcript" },
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ],
  followUps: [],
};

let actions: ActionsContextValue;
let state: ReturnType<typeof useSessionState>;
let models: ReturnType<typeof useModelState>;
let workspace: ReturnType<typeof useWorkspaceState>;
let messages: ReturnType<typeof useActiveTranscriptContextMessages>;

function Probe() {
  actions = useActions();
  state = useSessionState();
  models = useModelState();
  workspace = useWorkspaceState();
  messages = useActiveTranscriptContextMessages();
  useEffect(() => undefined);
  return <output data-testid="state">{workspace.bootState}</output>;
}

describe("HostProvider render integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persisted.values.clear();
    persisted.failWorkspaces = false;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => persisted.values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (persisted.failWorkspaces && key === STORAGE_KEYS.WORKSPACES) {
          throw new Error("storage full");
        }
        persisted.values.set(key, value);
      },
      removeItem: (key: string) => persisted.values.delete(key),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    Object.defineProperty(window, "electronAPI", { configurable: true, value: undefined });
    host.health.mockResolvedValue({ ok: true });
    host.listModelConnections.mockResolvedValue([
      { id: "provider-1", label: "Provider", modelIds: ["model-1"], defaultModelId: "model-1" },
    ]);
    host.listProjects.mockResolvedValue([{ directory: "/project" }]);
    host.listSessions.mockResolvedValue([summary]);
    host.readSession.mockResolvedValue(snapshot);
    host.subscribe.mockImplementation((_event, _session, connected) => {
      connected?.();
      return vi.fn();
    });
    host.registerProject.mockResolvedValue(undefined);
    host.unregisterProject.mockResolvedValue(undefined);
    host.deleteSession.mockResolvedValue(undefined);
    host.renameSession.mockResolvedValue(undefined);
    host.abort.mockResolvedValue(undefined);
    host.prompt.mockResolvedValue({ mode: "started", startedEntries: [] });
    host.setModel.mockResolvedValue(snapshot);
    host.setReasoning.mockResolvedValue(snapshot);
    host.findFiles.mockResolvedValue(["a.txt"]);
  });
  afterEach(cleanup);

  test("bootstraps, hydrates, orchestrates Host mutations, persists UI state, and cleans up", async () => {
    const unsubscribe = vi.fn();
    host.subscribe.mockImplementation((_event, _session, connected) => {
      connected?.();
      return unsubscribe;
    });
    const view = render(
      <IdentityActorProvider
        actor={{ type: "user", id: "user-1", displayName: "Ada", role: "owner" }}
      >
        <HostProvider>
          <Probe />
        </HostProvider>
      </IdentityActorProvider>,
    );

    expect(workspace.bootState).toBe("checking-server");
    await waitFor(() => expect(workspace.bootState).toBe("ready"));
    expect(workspace.activeDirectory).toBe("/project");
    expect(state.sessions.map((item) => item.id)).toEqual(["session-1"]);
    expect(models.selectedModel).toEqual({ providerID: "provider-1", modelID: "model-1" });

    await act(() => actions.selectSession("session-1"));
    await waitFor(() =>
      expect(messages[0]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "hydrated transcript" }),
        ]),
      ),
    );
    expect(host.readSession).toHaveBeenCalledWith("session-1");

    await act(() => actions.renameSession("session-1", "Renamed"));
    await act(() => actions.sendPrompt("continue"));
    expect(host.renameSession).toHaveBeenCalledWith("session-1", "Renamed");
    expect(host.prompt).toHaveBeenCalledWith("session-1", "continue");
    expect(state.isBusy).toBe(true);

    await act(() => actions.setReasoningEffort?.("high"));
    expect(host.setReasoning).toHaveBeenCalledWith("session-1", "high");
    await act(() => actions.setModel({ providerID: "provider-1", modelID: "model-1" }));
    expect(host.setModel).toHaveBeenCalledWith("session-1", {
      connectionId: "provider-1",
      modelId: "model-1",
    });

    await act(() => actions.abortSession());
    expect(host.abort).toHaveBeenCalledWith("session-1");
    expect(await actions.findFiles({ directory: "/project" }, "a")).toEqual(["a.txt"]);

    await act(() => actions.connectToProject("/other"));
    expect(host.registerProject).toHaveBeenCalledWith("/other");
    expect(workspace.activeDirectory).toBe("/other");
    await act(() => actions.removeProject("/other"));
    expect(host.unregisterProject).toHaveBeenCalledWith("/other");

    act(() => actions.setSessionPinned("session-1", true));
    expect(state.sessionMeta["session-1"]?.pinnedAt).toEqual(expect.any(String));
    await act(() => actions.deleteSession("session-1"));
    expect(host.deleteSession).toHaveBeenCalledWith("session-1");

    view.unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  test("surfaces bootstrap failure as a stable error state", async () => {
    host.health.mockRejectedValueOnce(new Error("Host offline"));
    render(
      <HostProvider>
        <Probe />
      </HostProvider>,
    );
    await waitFor(() => expect(workspace.bootState).toBe("error"));
    expect(workspace.bootError).toBe("Host offline");
  });

  test("persists Workspace add, switch, and remove while rolling back a failed write", async () => {
    vi.stubGlobal("navigator", { userAgent: "OpenGUI Electron/43.0" });
    render(
      <HostProvider>
        <Probe />
      </HostProvider>,
    );
    await waitFor(() => expect(workspace.bootState).toBe("ready"));
    const initialIds = workspace.workspaces.map(({ id }) => id);

    act(() => actions.createWorkspace({ name: "Remote", serverUrl: "https://remote.test" }));
    const remote = workspace.activeWorkspaceId;
    expect(remote).toMatch(/^host-/u);
    expect(JSON.parse(persisted.values.get(STORAGE_KEYS.WORKSPACES) ?? "[]")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: remote, name: "Remote" })]),
    );

    act(() => actions.switchWorkspace(initialIds[0]!));
    expect(workspace.activeWorkspaceId).toBe(initialIds[0]);
    expect(persisted.values.get(STORAGE_KEYS.ACTIVE_WORKSPACE_ID)).toBe(initialIds[0]);
    await act(() => actions.removeWorkspace(remote!));
    expect(workspace.workspaces.some(({ id }) => id === remote)).toBe(false);

    const beforeFailure = workspace.workspaces.map(({ id }) => id);
    persisted.failWorkspaces = true;
    act(() => actions.createWorkspace({ name: "Rejected", serverUrl: "https://full.test" }));
    expect(workspace.workspaces.map(({ id }) => id)).toEqual(beforeFailure);
  });

  test("unpins a Project using its workspace-scoped metadata key", async () => {
    const projectKey = makeProjectKey("local", "/project");
    persisted.values.set(
      STORAGE_KEYS.PROJECT_META,
      JSON.stringify({ [projectKey]: { pinnedAt: "2026-01-01T00:00:00.000Z" } }),
    );

    render(
      <HostProvider>
        <Probe />
      </HostProvider>,
    );
    await waitFor(() => expect(workspace.bootState).toBe("ready"));
    expect(workspace.projectMeta[projectKey]?.pinnedAt).toBeTruthy();

    act(() => actions.setProjectPinned("/project", false));

    expect(workspace.projectMeta[projectKey]?.pinnedAt).toBeUndefined();
    expect(
      (
        JSON.parse(persisted.values.get(STORAGE_KEYS.PROJECT_META) ?? "{}") as Record<
          string,
          unknown
        >
      )[projectKey],
    ).toBeUndefined();
  });
});
