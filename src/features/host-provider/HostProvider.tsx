import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionsContext,
  ConnectionContext,
  MessagesContext,
  ModelContext,
  SessionContext,
  type ActionsContextValue,
  type ConnectionContextValue,
  type ModelContextValue,
  type SessionContextValue,
} from "@/hooks/agent-contexts";
import type { Session } from "@/hooks/agent-state-types";
import {
  createLocalWorkspace,
  getActiveWorkspaceId,
  getProjectMetaMap,
  getSessionMetaMap,
  getStoredWorkspaces,
  LOCAL_WORKSPACE_ID,
  normalizeWorkspace,
  persistWorkspaces,
  persistProjectMetaMap,
  persistSessionMetaMap,
  type ProjectMetaMap,
  type SessionColor,
  type SessionMetaMap,
} from "@/hooks/agent-state-persistence";
import {
  ActiveSessionTranscriptProvider,
  useActiveTranscriptStore,
} from "@/features/session-transcript/active-session-transcript-provider";
import { createHostClient } from "@/protocol/host-client";
import type {
  HostEvent,
  HostSessionSnapshot,
  HostSessionSummary,
  OpenGuiHostClient,
  ReasoningEffort,
} from "@/protocol/host-types";
import {
  applyHostTranscriptEvent,
  createHostTranscriptStream,
  projectHostSnapshotToMessages,
  projectHostTranscriptStream,
  type HostTranscriptStream,
} from "@/protocol/host-transcript";
import type { Provider } from "@/protocol/agent-types";
import type { SelectedModel } from "@/types/electron";
import type { Workspace } from "@/types/electron";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";
import { findModel, normalizeProjectPath } from "@/lib/utils";
import { shouldAutoNameSession } from "@/hooks/agent-session-utils";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageSet } from "@/lib/safe-storage";
import { connectionsToModelProviders } from "@/lib/models-dev";
import { notifyError, notifyUnknownError } from "@/lib/notify";
import { getDesktopShellClient } from "@/runtime/clients";
import { selectedModelFromHostSnapshot } from "@/features/host-provider/host-session-selection";

function toSession(
  summary: HostSessionSummary | HostSessionSnapshot,
  workspaceId: string,
): Session {
  const model = "model" in summary ? summary.model : null;
  return {
    id: summary.id,
    title: summary.title,
    directory: summary.projectDirectory,
    time: {
      created: Date.parse(summary.createdAt) || Date.now(),
      updated: Date.parse(summary.updatedAt) || Date.now(),
    },
    model: model ? { providerID: model.connectionId, id: model.modelId } : undefined,
    _projectDir: summary.projectDirectory,
    _workspaceId: workspaceId,
  };
}

function createRuntimeHostClient(workspace: Workspace): OpenGuiHostClient {
  const electronApi = window.electronAPI;
  if (electronApi?.kind === "electron" && workspace.isLocal) {
    return createHostClient({
      baseUrl: electronApi.backendUrl ?? "",
      token: electronApi.backendToken ?? undefined,
      resolveBaseUrl: () => electronApi.backendUrl ?? undefined,
      resolveToken: () => electronApi.backendToken ?? undefined,
      fetchImpl: async (input, init) => {
        if (
          electronApi.backendFetch &&
          typeof input === "string" &&
          !input.includes("/api/host/events")
        ) {
          const headers = new Headers(init?.headers);
          const response = await electronApi.backendFetch({
            url: input.startsWith("http")
              ? input
              : `${(electronApi.backendUrl ?? "").replace(/\/+$/, "")}${input}`,
            method: init?.method ?? "GET",
            headers: Object.fromEntries(headers.entries()),
            body: typeof init?.body === "string" ? init.body : null,
          });
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        return fetch(input, init);
      },
    });
  }
  return createHostClient({
    baseUrl: workspace.serverUrl || window.location.origin,
    token: workspace.authToken || "",
  });
}

function initialWorkspaces() {
  const policy = getShellWorkspacePolicy();
  const stored = getStoredWorkspaces();
  if (policy.shellKind === "mobile") return stored.filter((item) => !item.isLocal);
  if (policy.shellKind === "web") return [createLocalWorkspace()];
  const local = stored.find((item) => item.id === LOCAL_WORKSPACE_ID) ?? createLocalWorkspace();
  return [local, ...stored.filter((item) => item.id !== LOCAL_WORKSPACE_ID)];
}

function HostProviderBody({
  children,
  detachedProject,
}: {
  children: ReactNode;
  detachedProject?: string;
}) {
  const transcriptStore = useActiveTranscriptStore();
  const policy = useMemo(() => getShellWorkspacePolicy(), []);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(initialWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() =>
    getActiveWorkspaceId(initialWorkspaces()),
  );
  const workspace =
    workspaces.find((item) => item.id === activeWorkspaceId) ?? workspaces[0] ?? null;
  const host = useMemo(() => (workspace ? createRuntimeHostClient(workspace) : null), [workspace]);
  const [projects, setProjects] = useState<string[]>(() =>
    detachedProject ? [normalizeProjectPath(detachedProject)] : [],
  );
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeTargetDirectory, setActiveTargetDirectory] = useState<string | null>(
    detachedProject ? normalizeProjectPath(detachedProject) : null,
  );
  const [busySessionIds, setBusySessionIds] = useState<Set<string>>(new Set());
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedModel, setSelectedModel] = useState<SelectedModel | null>(null);
  const [reasoningEffort, setReasoningEffortState] = useState<ReasoningEffort>(() => {
    const stored = storageGet(STORAGE_KEYS.REASONING_EFFORT);
    return stored === "none" ||
      stored === "minimal" ||
      stored === "low" ||
      stored === "medium" ||
      stored === "high" ||
      stored === "xhigh" ||
      stored === "max"
      ? stored
      : "medium";
  });
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, string>>({});
  const [sessionMeta, setSessionMeta] = useState<SessionMetaMap>(() => getSessionMetaMap());
  const [projectMeta, setProjectMeta] = useState<ProjectMetaMap>(() => getProjectMetaMap());
  const [bootState, setBootState] = useState<
    "idle" | "checking-server" | "starting-server" | "ready" | "error"
  >("checking-server");
  const [bootError, setBootError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [queuedPrompts, setQueuedPrompts] = useState<
    Record<string, Array<{ id: string; text: string; mode: "queue" }>>
  >({});
  const activeSnapshotRef = useRef<HostSessionSnapshot | null>(null);
  const activeStreamRef = useRef<HostTranscriptStream | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);

  const requireHost = useCallback(() => {
    if (!host) throw new Error("Connect to an OpenGUI Host first");
    return host;
  }, [host]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const refreshModels = useCallback(async () => {
    if (!host) return;
    const connections = await host.listModelConnections();
    const nextProviders = await connectionsToModelProviders(connections);
    setProviders(nextProviders);
    if (!selectedModel && connections[0]?.modelIds[0]) {
      setSelectedModel({
        providerID: connections[0].id,
        modelID: connections[0].modelIds[0],
      });
    }
  }, [host, selectedModel]);

  const refreshProjects = useCallback(async () => {
    if (!host) return;
    const listed = await host.listProjects();
    const directories = listed.map((project) => normalizeProjectPath(project.directory));
    setProjects(directories);
    if (!activeTargetDirectory && directories[0]) {
      setActiveTargetDirectory(directories[0]);
    }
  }, [activeTargetDirectory, host]);

  const refreshSessions = useCallback(
    async (directory = activeTargetDirectory) => {
      if (!directory) {
        setSessions([]);
        return;
      }
      if (!host) return;
      const listed = await host.listSessions(directory);
      setSessions(listed.map((item) => toSession(item, LOCAL_WORKSPACE_ID)));
      setBusySessionIds(
        new Set(listed.filter((item) => item.status === "running").map((item) => item.id)),
      );
      setQueuedPrompts((current) => {
        const next = { ...current };
        for (const item of listed) {
          // Keep only known queues; host follow-ups are reloaded with session reads.
          if (!(item.id in next)) next[item.id] = [];
        }
        return next;
      });
    },
    [activeTargetDirectory, host],
  );

  const hydrateTranscript = useCallback(
    async (sessionId: string | null) => {
      if (!sessionId) {
        transcriptStore.select(null);
        activeSnapshotRef.current = null;
        activeStreamRef.current = null;
        return;
      }
      if (!host) return;
      const scope = {
        directory: activeTargetDirectory ?? "",
        sessionId,
      };
      transcriptStore.select(scope);
      const snapshot = await host.readSession(sessionId);
      activeSnapshotRef.current = snapshot;
      activeStreamRef.current = createHostTranscriptStream(snapshot);
      setSelectedModel(selectedModelFromHostSnapshot(snapshot));
      if (snapshot.reasoning) setReasoningEffortState(snapshot.reasoning);
      const messages = projectHostSnapshotToMessages(snapshot);
      transcriptStore.dispatch({
        type: "page.loaded",
        scope,
        phase: "initial",
        messages,
        hasMore: false,
        nextCursor: null,
      });
      setQueuedPrompts((current) => ({
        ...current,
        [sessionId]: snapshot.followUps.map((item) => ({
          id: item.id,
          text: item.prompt.text,
          mode: "queue" as const,
        })),
      }));
      setBusySessionIds((current) => {
        const next = new Set(current);
        if (snapshot.status === "running") next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
    },
    [activeTargetDirectory, host, transcriptStore],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!host) {
        setProjects([]);
        setSessions([]);
        setBootState("idle");
        return;
      }
      try {
        setBootState("checking-server");
        await host.health();
        if (cancelled) return;
        await refreshModels();
        await refreshProjects();
        await refreshSessions();
        if (storageGet(STORAGE_KEYS.SETUP_COMPLETE) !== "true") {
          // Keep setup wizard available; host health is enough for ready.
        }
        setBootState("ready");
      } catch (error) {
        if (cancelled) return;
        setBootState("error");
        setBootError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, refreshModels, refreshProjects, refreshSessions]);

  useEffect(() => {
    if (!host) return;
    if (!activeSessionId) {
      void hydrateTranscript(null);
      return;
    }
    if (activeStreamRef.current?.snapshot.id === activeSessionId) return;
    void hydrateTranscript(activeSessionId);
  }, [activeSessionId, hydrateTranscript]);

  useEffect(() => {
    if (!host) return;
    const handleEvent = (hostEvent: HostEvent) => {
      const terminalEntry =
        hostEvent.event.type === "entry_appended" &&
        ["run_completed", "run_failed", "run_aborted", "run_interrupted"].includes(
          hostEvent.event.entry.kind,
        );
      setBusySessionIds((current) => {
        const next = new Set(current);
        if (
          hostEvent.event.type === "assistant_delta" ||
          (hostEvent.event.type === "entry_appended" &&
            hostEvent.event.entry.kind === "run_started")
        ) {
          next.add(hostEvent.sessionId);
        } else if (terminalEntry) {
          next.delete(hostEvent.sessionId);
        }
        return next;
      });

      const stream = activeStreamRef.current;
      if (stream && stream.snapshot.id === hostEvent.sessionId) {
        const nextStream = applyHostTranscriptEvent(stream, hostEvent);
        activeStreamRef.current = nextStream;
        activeSnapshotRef.current = nextStream.snapshot;
        const scope = {
          directory: nextStream.snapshot.projectDirectory,
          sessionId: hostEvent.sessionId,
        };
        transcriptStore.dispatch({
          type: "page.loaded",
          scope,
          phase: "initial",
          messages: projectHostTranscriptStream(nextStream),
          hasMore: false,
          nextCursor: null,
        });
      }

      if (terminalEntry) void refreshSessions().catch(notifyUnknownError);
    };
    return host.subscribe(handleEvent, undefined, () => {
      const sessionId = activeSessionIdRef.current;
      if (sessionId) void hydrateTranscript(sessionId).catch(notifyUnknownError);
    });
  }, [host, hydrateTranscript, refreshSessions, transcriptStore]);

  const sessionValue = useMemo<SessionContextValue>(
    () => ({
      sessions,
      activeSessionId,
      isBusy: activeSessionId ? busySessionIds.has(activeSessionId) : false,
      busySessionIds,
      queuedPrompts: Object.fromEntries(
        Object.entries(queuedPrompts).map(([sessionId, items]) => [
          sessionId,
          items.map((item) => ({
            id: item.id,
            text: item.text,
            mode: "queue" as const,
            createdAt: Date.now(),
          })),
        ]),
      ),
      pendingPermissions: {},
      pendingQuestions: {},
      activeTargetDirectory,
      namingSessionIds: new Set(),
      unreadSessionIds: new Set(),
      sessionDrafts,
      sessionMeta,
      sessionErrors: {},
    }),
    [
      activeSessionId,
      activeTargetDirectory,
      busySessionIds,
      queuedPrompts,
      sessionDrafts,
      sessionMeta,
      sessions,
    ],
  );

  const effectiveReasoningEffort = useMemo(() => {
    if (!selectedModel) return reasoningEffort;
    const model = findModel(providers, selectedModel.providerID, selectedModel.modelID);
    if (model?.capabilities.reasoning === false) return "none" as const;
    const supported = model?.reasoningEfforts;
    if (!supported?.length || supported.includes(reasoningEffort)) return reasoningEffort;
    return supported.includes("medium") ? "medium" : supported[0];
  }, [providers, reasoningEffort, selectedModel]);

  const modelValue = useMemo<ModelContextValue>(
    () => ({
      providers,
      providerDefaults: {},
      selectedModel,
      agents: [],
      selectedAgent: null,
      variantSelections: {},
      commands: [],
      currentVariant: undefined,
      reasoningEffort: effectiveReasoningEffort,
    }),
    [effectiveReasoningEffort, providers, selectedModel],
  );

  const connectionValue = useMemo<ConnectionContextValue>(
    () => ({
      workspaces: workspaces.map((item) =>
        item.id === activeWorkspaceId ? { ...item, projects } : item,
      ),
      activeWorkspace: workspace ? { ...workspace, projects } : null,
      activeWorkspaceId,
      supportsMultipleWorkspaces: policy.supportsMultipleWorkspaces,
      canManageProjects: Boolean(workspace),
      workspaceStatuses: workspace
        ? {
            [workspace.id]: {
              busy: busySessionIds.size > 0,
              needsAttention: false,
              error: bootState === "error",
              connected: bootState === "ready",
            },
          }
        : {},
      connections: Object.fromEntries(
        projects.map((directory) => [
          directory,
          {
            state: "connected" as const,
            serverUrl: null,
            serverVersion: null,
            error: null,
            lastEventAt: Date.now(),
          },
        ]),
      ),
      workspaceDirectory: activeTargetDirectory,
      defaultChatDirectory: null,
      workspaceServerUrl: workspace?.serverUrl ?? null,
      isLocalWorkspace: Boolean(workspace?.isLocal),
      supportsNativeDirectoryPicker: policy.shellKind === "desktop" && Boolean(workspace?.isLocal),
      attachmentBaseUrl: workspace?.serverUrl ?? null,
      activeDirectory: activeTargetDirectory,
      bootState,
      bootError,
      bootLogs: null,
      lastError,
      projectMeta,
      workspaceResources: {},
    }),
    [
      activeTargetDirectory,
      bootError,
      bootState,
      busySessionIds.size,
      lastError,
      projectMeta,
      projects,
      sessions,
      workspace,
      workspaces,
      activeWorkspaceId,
      policy,
    ],
  );

  const actions = useMemo<ActionsContextValue>(() => {
    const connectToProject = async (directory: string) => {
      if (!host) throw new Error("Connect to an OpenGUI Host first");
      const normalized = normalizeProjectPath(directory);
      await host.registerProject(normalized);
      setProjects((current) => (current.includes(normalized) ? current : [normalized, ...current]));
      setActiveTargetDirectory(normalized);
      await refreshSessions(normalized);
    };

    return {
      removeProject: async (directory) => {
        const normalized = normalizeProjectPath(directory);
        await requireHost().unregisterProject(normalized);
        setProjects((current) => current.filter((item) => item !== normalized));
        if (activeTargetDirectory === normalized) {
          setActiveTargetDirectory(null);
          setActiveSessionId(null);
        }
        await refreshSessions(null as unknown as string);
        setSessions((current) => current.filter((session) => session.directory !== normalized));
      },
      selectSession: async (id) => {
        setActiveSessionId(id);
        if (id) {
          const session = sessions.find((item) => item.id === id);
          if (session?.directory) setActiveTargetDirectory(session.directory);
        }
      },
      loadOlderMessages: async () => false,
      deleteSession: async (id) => {
        await requireHost().deleteSession(id);
        if (activeSessionId === id) setActiveSessionId(null);
        await refreshSessions();
      },
      renameSession: async (id, title) => {
        await requireHost().renameSession(id, title);
        await refreshSessions();
      },
      sendPrompt: async (text) => {
        try {
          let sessionId = activeSessionId;
          let directory = activeTargetDirectory;
          if (!directory && detachedProject) directory = normalizeProjectPath(detachedProject);
          if (!directory) throw new Error("Connect a project before sending");
          if (!sessionId) {
            if (!selectedModel) throw new Error("Select a model before sending");
            const created = await requireHost().createSession({
              directory,
              title: text.trim(),
              model: {
                connectionId: selectedModel.providerID,
                modelId: selectedModel.modelID,
              },
              reasoning: effectiveReasoningEffort,
            });
            sessionId = created.id;
            activeSessionIdRef.current = sessionId;
            activeSnapshotRef.current = created;
            activeStreamRef.current = createHostTranscriptStream(created);
            const scope = { directory, sessionId };
            transcriptStore.select(scope);
            transcriptStore.dispatch({
              type: "page.loaded",
              scope,
              phase: "initial",
              messages: projectHostTranscriptStream(activeStreamRef.current),
              hasMore: false,
              nextCursor: null,
            });
            setActiveSessionId(sessionId);
            await refreshSessions(directory);
          } else {
            const session = sessions.find((item) => item.id === sessionId);
            if (shouldAutoNameSession(session)) {
              await requireHost().renameSession(sessionId, text.trim());
              await refreshSessions(directory);
            }
          }
          setBusySessionIds((current) => new Set(current).add(sessionId!));
          await requireHost().prompt(sessionId, text);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setLastError(message);
          notifyError(message);
          throw error;
        }
      },
      findFiles: async (target, query) => {
        const directory = target?.directory || activeTargetDirectory;
        if (!directory) return [];
        return requireHost().findFiles(directory, query);
      },
      sendCommand: async () => {
        throw new Error("Slash commands are not available in the first-party Host");
      },
      summarizeSession: async () => {
        throw new Error("Summarize is not available yet");
      },
      abortSession: async () => {
        if (!activeSessionId) return;
        await requireHost().abort(activeSessionId);
        await hydrateTranscript(activeSessionId);
        await refreshSessions();
      },
      respondPermission: async () => {},
      replyQuestion: async () => {},
      rejectQuestion: async () => {},
      setModel: (model) => setSelectedModel(model),
      setPromptBoxSelection: ({ model }) => setSelectedModel(model),
      setAgent: () => {},
      cycleVariant: () => {},
      revertVariant: () => {},
      setReasoningEffort: async (effort) => {
        const previous = reasoningEffort;
        setReasoningEffortState(effort);
        storageSet(STORAGE_KEYS.REASONING_EFFORT, effort);
        if (!activeSessionId) return;
        try {
          const snapshot = await requireHost().setReasoning(activeSessionId, effort);
          activeSnapshotRef.current = snapshot;
        } catch (error) {
          setReasoningEffortState(previous);
          storageSet(STORAGE_KEYS.REASONING_EFFORT, previous);
          throw error;
        }
      },
      clearError: () => setLastError(null),
      refreshProviders: async () => {
        await refreshModels();
      },
      getQueuedPrompts: (sessionId) =>
        (queuedPrompts[sessionId] ?? []).map((item) => ({
          id: item.id,
          text: item.text,
          mode: "queue" as const,
          createdAt: Date.now(),
        })),
      removeFromQueue: () => {},
      reorderQueue: () => {},
      updateQueuedPrompt: () => {},
      sendQueuedNow: async () => {},
      setSessionDraft: (key, text) => setSessionDrafts((current) => ({ ...current, [key]: text })),
      clearSessionDraft: (key) =>
        setSessionDrafts((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        }),
      openDirectory: async () => getDesktopShellClient().dialog.openDirectory(),
      connectToProject,
      startNewChat: async () => {
        const directory = activeTargetDirectory;
        if (!directory) throw new Error("Connect a project before starting a chat");
        if (!selectedModel) throw new Error("Select a model before starting a chat");
        const created = await requireHost().createSession({
          directory,
          model: {
            connectionId: selectedModel.providerID,
            modelId: selectedModel.modelID,
          },
          reasoning: effectiveReasoningEffort,
        });
        setActiveSessionId(created.id);
        await refreshSessions(directory);
        await hydrateTranscript(created.id);
      },
      setActiveTarget: (directory) => {
        setActiveTargetDirectory(normalizeProjectPath(directory));
        setActiveSessionId(null);
        void refreshSessions(normalizeProjectPath(directory));
      },
      setDefaultChatDirectory: () => {},
      setActiveTargetDirectory: (directory) =>
        setActiveTargetDirectory(normalizeProjectPath(directory)),
      revertToMessage: async () => {},
      unrevert: async () => {},
      forkFromMessage: async () => {},
      setSessionColor: (sessionId, color: SessionColor) => {
        setSessionMeta((current) => {
          const next = { ...current, [sessionId]: { ...current[sessionId], color } };
          persistSessionMetaMap(next);
          return next;
        });
      },
      setSessionTags: (sessionId, tags) => {
        setSessionMeta((current) => {
          const next = { ...current, [sessionId]: { ...current[sessionId], tags } };
          persistSessionMetaMap(next);
          return next;
        });
      },
      setSessionPinned: (sessionId, pinned) => {
        setSessionMeta((current) => {
          const next = {
            ...current,
            [sessionId]: {
              ...current[sessionId],
              pinnedAt: pinned ? new Date().toISOString() : undefined,
            },
          };
          persistSessionMetaMap(next);
          return next;
        });
      },
      moveSessionToProject: async () => {},
      removeSessionFromProject: async () => {},
      setProjectPinned: (directory, pinned) => {
        setProjectMeta((current) => {
          const next = {
            ...current,
            [directory]: {
              ...current[directory],
              pinnedAt: pinned ? new Date().toISOString() : undefined,
            },
          };
          persistProjectMetaMap(next);
          return next;
        });
      },
      createWorkspace: (input) => {
        const nextWorkspace = normalizeWorkspace({
          id: `host-${crypto.randomUUID()}`,
          name: input.name,
          serverUrl: input.serverUrl,
          authToken: input.authToken,
          isLocal: false,
          projects: [],
          settings: { serverUrl: input.serverUrl, authToken: input.authToken, isLocal: false },
        });
        const next = [...workspaces, nextWorkspace];
        persistWorkspaces(next);
        setWorkspaces(next);
        setActiveWorkspaceId(nextWorkspace.id);
        storageSet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, nextWorkspace.id);
        setProjects([]);
        setSessions([]);
        setActiveSessionId(null);
        setActiveTargetDirectory(null);
      },
      updateWorkspace: (workspaceId, input) => {
        const next = workspaces.map((item) =>
          item.id === workspaceId
            ? normalizeWorkspace({ ...item, ...input, settings: { ...item.settings, ...input } })
            : item,
        );
        persistWorkspaces(next);
        setWorkspaces(next);
      },
      removeWorkspace: async (workspaceId) => {
        if (workspaceId === LOCAL_WORKSPACE_ID) return;
        const next = workspaces.filter((item) => item.id !== workspaceId);
        persistWorkspaces(next);
        setWorkspaces(next);
        if (activeWorkspaceId === workspaceId) {
          const fallback = next[0]?.id ?? "";
          setActiveWorkspaceId(fallback);
          storageSet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, fallback);
        }
      },
      switchWorkspace: (workspaceId) => {
        if (!workspaces.some((item) => item.id === workspaceId)) return;
        setActiveWorkspaceId(workspaceId);
        storageSet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, workspaceId);
        setProjects([]);
        setSessions([]);
        setActiveSessionId(null);
        setActiveTargetDirectory(null);
      },
      reorderWorkspaces: (fromIndex, toIndex) => {
        const next = [...workspaces];
        const [moved] = next.splice(fromIndex, 1);
        if (!moved) return;
        next.splice(toIndex, 0, moved);
        persistWorkspaces(next);
        setWorkspaces(next);
      },
      reorderVisibleProjects: (orderedDirectories) => setProjects(orderedDirectories),
    };
  }, [
    activeSessionId,
    activeTargetDirectory,
    detachedProject,
    host,
    hydrateTranscript,
    queuedPrompts,
    refreshModels,
    requireHost,
    refreshSessions,
    effectiveReasoningEffort,
    reasoningEffort,
    selectedModel,
    sessions,
    workspaces,
    activeWorkspaceId,
  ]);

  return (
    <SessionContext.Provider value={sessionValue}>
      <MessagesContext.Provider value={{ turnRuns: {} }}>
        <ModelContext.Provider value={modelValue}>
          <ConnectionContext.Provider value={connectionValue}>
            <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
          </ConnectionContext.Provider>
        </ModelContext.Provider>
      </MessagesContext.Provider>
    </SessionContext.Provider>
  );
}

export function HostProvider({
  children,
  detachedProject,
}: {
  children: ReactNode;
  detachedProject?: string;
}) {
  return (
    <ActiveSessionTranscriptProvider>
      <HostProviderBody detachedProject={detachedProject}>{children}</HostProviderBody>
    </ActiveSessionTranscriptProvider>
  );
}

// Keep setup complete flag writable for wizard completion.
export function markSetupComplete() {
  storageSet(STORAGE_KEYS.SETUP_COMPLETE, "true");
}
