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
  listSkills: vi.fn(),
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
    // Existing transcript locks skill edits; first send still pins an explicit
    // allowlist into the Host prompt (and thus the system prompt catalog).
    host.listSkills.mockResolvedValue([
      {
        name: "code-review",
        description: "Review",
        source: "project",
        manual: false,
      },
      {
        name: "impeccable",
        description: "Design",
        source: "host",
        manual: true,
      },
    ]);
    await act(() => actions.sendPrompt("continue"));
    expect(host.renameSession).toHaveBeenCalledWith("session-1", "Renamed");
    expect(host.listSkills).toHaveBeenCalledWith("/project");
    expect(host.prompt).toHaveBeenCalledWith("session-1", "continue", {
      skills: ["code-review"],
    });
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
    await act(() => actions.moveSessionToProject("session-1", "/other/"));
    expect(state.sessionMeta["session-1"]).toEqual(
      expect.objectContaining({
        sidebarSection: "projects",
        displayProjectDir: "/other",
        sidebarMovedAt: expect.any(Number),
      }),
    );
    expect(JSON.parse(persisted.values.get(STORAGE_KEYS.SESSION_META) ?? "{}")).toEqual(
      expect.objectContaining({
        "session-1": expect.objectContaining({
          sidebarSection: "projects",
          displayProjectDir: "/other",
        }),
      }),
    );
    await act(() => actions.removeSessionFromProject("session-1"));
    expect(state.sessionMeta["session-1"]).toEqual(
      expect.objectContaining({ sidebarSection: "chats", displayProjectDir: null }),
    );
    await act(() => actions.deleteSession("session-1"));
    expect(host.deleteSession).toHaveBeenCalledWith("session-1");

    view.unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  test("sends an explicit empty allowlist when every skill is disabled in a new chat", async () => {
    const created: HostSessionSnapshot = {
      ...snapshot,
      id: "session-new",
      title: "No skills",
      entries: [],
    };
    host.createSession.mockResolvedValue(created);
    host.listSessions.mockResolvedValue([]);

    render(
      <HostProvider>
        <Probe />
      </HostProvider>,
    );
    await waitFor(() => expect(workspace.bootState).toBe("ready"));
    await act(() => actions.selectSession(null));

    const catalog = [
      {
        name: "code-review",
        description: "Review",
        source: "project" as const,
        manual: false,
      },
    ];
    act(() => {
      actions.ensureSessionSkills(catalog);
      actions.toggleSessionSkill("code-review", catalog);
    });
    await waitFor(() => expect(state.enabledSkillNames).toEqual([]));

    await act(() => actions.sendPrompt("No skills", undefined, []));

    expect(host.prompt).toHaveBeenCalledWith("session-new", "No skills", { skills: [] });
  });

  test("submits only two selected skills from a large auto-enabled catalog", async () => {
    const created: HostSessionSnapshot = {
      ...snapshot,
      id: "session-two-skills",
      title: "Two skills",
      entries: [],
    };
    host.createSession.mockResolvedValue(created);
    host.listSessions.mockResolvedValue([]);

    render(
      <HostProvider>
        <Probe />
      </HostProvider>,
    );
    await waitFor(() => expect(workspace.bootState).toBe("ready"));
    await act(() => actions.selectSession(null));

    const names = [
      "agent-browser",
      "code-review",
      "codebase-design",
      "diagnosing-bugs",
      "dogfood",
      "domain-modeling",
      "grilling",
      "impeccable",
      "prototype",
      "research",
      "resolving-merge-conflicts",
      "tdd",
    ];
    const catalog = names.map((name) => ({
      name,
      description: name,
      source: "project" as const,
      manual: false,
    }));
    act(() => actions.ensureSessionSkills(catalog));
    await waitFor(() => expect(state.enabledSkillNames).toEqual(names));

    const selected = new Set(["dogfood", "impeccable"]);
    for (const name of names.filter((name) => !selected.has(name))) {
      act(() => actions.toggleSessionSkill(name, catalog));
    }
    await waitFor(() => expect(state.enabledSkillNames).toEqual(["dogfood", "impeccable"]));

    await act(() => actions.sendPrompt("Which skills?", undefined, ["dogfood", "impeccable"]));

    expect(host.prompt).toHaveBeenCalledWith("session-two-skills", "Which skills?", {
      skills: ["dogfood", "impeccable"],
    });
  });

  test("steer mode queues an after-part Follow-up without interrupting immediately", async () => {
    host.prompt.mockResolvedValue({
      mode: "follow_up",
      followUp: {
        id: "follow-steer",
        sequence: 1,
        prompt: { text: "steer me" },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    });

    render(
      <IdentityActorProvider
        actor={{ type: "user", id: "user-1", displayName: "Ada", role: "owner" }}
      >
        <HostProvider>
          <Probe />
        </HostProvider>
      </IdentityActorProvider>,
    );
    await waitFor(() => expect(workspace.bootState).toBe("ready"));
    await act(() => actions.selectSession("session-1"));
    await waitFor(() =>
      expect(messages[0]?.parts?.[0]).toMatchObject({ text: "hydrated transcript" }),
    );

    await act(() => actions.sendPrompt("steer me", "after-part", ["code-review"]));

    expect(host.prompt).toHaveBeenCalledWith("session-1", "steer me", {
      skills: ["code-review"],
    });
    expect(host.sendFollowUpNow).not.toHaveBeenCalled();
    expect(actions.getQueuedPrompts("session-1")).toEqual([
      expect.objectContaining({ id: "follow-steer", text: "steer me", mode: "after-part" }),
    ]);
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
