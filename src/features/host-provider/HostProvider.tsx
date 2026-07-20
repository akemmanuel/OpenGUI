import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ActionsContext,
  ModelContext,
  SessionContext,
  WorkspaceContext,
  type ModelContextValue,
  type SessionContextValue,
  type WorkspaceContextValue,
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
  type SessionColor,
} from "@/lib/persistence";
import {
  ActiveSessionTranscriptProvider,
  useActiveTranscriptStore,
} from "@/features/session-transcript/active-session-transcript-provider";
import { createHostClient } from "@/protocol/host-client";
import type {
  HostSessionSnapshot,
  HostSessionSummary,
  OpenGuiHostClient,
} from "@/protocol/host-types";
import {
  applyHostTranscriptEvent,
  createHostTranscriptStream,
  projectHostSnapshotToMessages,
  projectHostTranscriptStream,
  type HostTranscriptStream,
} from "@/protocol/host-transcript";
import type { Workspace } from "@/types/workspace";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";
import { normalizeProjectPath } from "@/lib/path";
import { findModel } from "@/lib/utils";
import { shouldAutoNameSession } from "@/hooks/agent-session-utils";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageSet } from "@/lib/persistence/storage";
import { connectionsToModelProviders } from "@/lib/models-dev";
import { notifyError, notifyUnknownError } from "@/lib/notify";
import { getDesktopShellClient } from "@/runtime/clients";
import { selectedModelFromHostSnapshot } from "@/features/host-provider/host-session-selection";
import { persistHostModelSelection } from "@/features/host-provider/host-model-selection";
import { loadHostSessionSummaries } from "@/features/host-provider/host-session-list";
import {
  useHostSlice,
  type ModelSlice,
  type ProjectSlice,
  type SessionSlice,
  type TransportSlice,
  type WorkspaceSlice,
} from "@/features/host-provider/host-domain-state";
import { useHostEventStream } from "@/features/host-provider/host-event-stream";
import { HostQueueController, useHostActions } from "@/features/host-provider/host-actions";

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
  const workspaceSlice = useHostSlice<WorkspaceSlice>(() => {
    const workspaces = initialWorkspaces();
    return { workspaces, activeWorkspaceId: getActiveWorkspaceId(workspaces) };
  });
  const { workspaces, activeWorkspaceId } = workspaceSlice.state;
  const setWorkspaces = workspaceSlice.setter("workspaces");
  const setActiveWorkspaceId = workspaceSlice.setter("activeWorkspaceId");
  const workspace =
    workspaces.find((item) => item.id === activeWorkspaceId) ?? workspaces[0] ?? null;
  const host = useMemo(() => (workspace ? createRuntimeHostClient(workspace) : null), [workspace]);
  const projectSlice = useHostSlice<ProjectSlice>(() => ({
    projects: detachedProject ? [normalizeProjectPath(detachedProject)] : [],
    activeTargetDirectory: detachedProject ? normalizeProjectPath(detachedProject) : null,
    projectMeta: getProjectMetaMap(),
  }));
  const { projects, activeTargetDirectory, projectMeta } = projectSlice.state;
  const setProjects = projectSlice.setter("projects");
  const setActiveTargetDirectory = projectSlice.setter("activeTargetDirectory");
  const setProjectMeta = projectSlice.setter("projectMeta");
  const projectsRef = useRef(projects);
  const sessionSlice = useHostSlice<SessionSlice>(() => ({
    sessions: [],
    activeSessionId: null,
    busySessionIds: new Set(),
    queuedPrompts: {},
    sessionDrafts: {},
    sessionMeta: getSessionMetaMap(),
  }));
  const { sessions, activeSessionId, busySessionIds, queuedPrompts, sessionDrafts, sessionMeta } =
    sessionSlice.state;
  const setSessions = sessionSlice.setter("sessions");
  const setActiveSessionId = sessionSlice.setter("activeSessionId");
  const setBusySessionIds = sessionSlice.setter("busySessionIds");
  const setQueuedPrompts = sessionSlice.setter("queuedPrompts");
  const setSessionDrafts = sessionSlice.setter("sessionDrafts");
  const setSessionMeta = sessionSlice.setter("sessionMeta");
  const activeTargetDirectoryRef = useRef(activeTargetDirectory);
  const modelSlice = useHostSlice<ModelSlice>(() => {
    const stored = storageGet(STORAGE_KEYS.REASONING_EFFORT);
    const reasoningEffort =
      stored === "none" ||
      stored === "minimal" ||
      stored === "low" ||
      stored === "medium" ||
      stored === "high" ||
      stored === "xhigh" ||
      stored === "max" ||
      stored === "ultra"
        ? stored
        : "medium";
    return { providers: [], selectedModel: null, reasoningEffort };
  });
  const { providers, selectedModel, reasoningEffort } = modelSlice.state;
  const setProviders = modelSlice.setter("providers");
  const setSelectedModel = modelSlice.setter("selectedModel");
  const setReasoningEffortState = modelSlice.setter("reasoningEffort");
  const transportSlice = useHostSlice<TransportSlice>(() => ({
    bootState: "checking-server",
    bootError: null,
    lastError: null,
  }));
  const { bootState, bootError, lastError } = transportSlice.state;
  const setBootState = transportSlice.setter("bootState");
  const setBootError = transportSlice.setter("bootError");
  const setLastError = transportSlice.setter("lastError");
  const activeSnapshotRef = useRef<HostSessionSnapshot | null>(null);
  const activeStreamRef = useRef<HostTranscriptStream | null>(null);
  const hydratingSessionIdsRef = useRef(new Set<string>());
  const activeSessionIdRef = useRef(activeSessionId);
  const queuedPromptsRef = useRef(queuedPrompts);

  queuedPromptsRef.current = queuedPrompts;
  const queueController = useMemo(
    () =>
      host ? new HostQueueController(host, () => queuedPromptsRef.current, setQueuedPrompts) : null,
    [host, setQueuedPrompts],
  );

  const requireHost = useCallback(() => {
    if (!host) throw new Error("Connect to an OpenGUI Host first");
    return host;
  }, [host]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    activeTargetDirectoryRef.current = activeTargetDirectory;
  }, [activeTargetDirectory]);

  const replaceProjects = useCallback((nextProjects: string[]) => {
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
  }, []);

  const refreshModels = useCallback(async () => {
    if (!host) return;
    const connections = await host.listModelConnections();
    const nextProviders = await connectionsToModelProviders(connections);
    setProviders(nextProviders);
    const defaultModelId = connections[0]?.defaultModelId ?? connections[0]?.modelIds[0];
    if (connections[0] && defaultModelId) {
      setSelectedModel(
        (current) =>
          current ?? {
            providerID: connections[0]!.id,
            modelID: defaultModelId,
          },
      );
    }
  }, [host]);

  const refreshProjects = useCallback(async () => {
    if (!host) return [];
    const listed = await host.listProjects();
    const directories = listed.map((project) => normalizeProjectPath(project.directory));
    replaceProjects(directories);
    setActiveTargetDirectory((current) => current ?? directories[0] ?? null);
    return directories;
  }, [host, replaceProjects]);

  const refreshSessions = useCallback(
    async (directories = projectsRef.current) => {
      if (directories.length === 0) {
        setSessions([]);
        setBusySessionIds(new Set());
        return;
      }
      if (!host) return;
      const listed = await loadHostSessionSummaries(host, directories);
      setSessions(listed.map((item) => toSession(item, activeWorkspaceId)));
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
    [activeWorkspaceId, host],
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
      if (hydratingSessionIdsRef.current.has(sessionId)) return;
      hydratingSessionIdsRef.current.add(sessionId);
      const scope = {
        directory: activeTargetDirectoryRef.current ?? "",
        sessionId,
      };
      transcriptStore.select(scope);
      try {
        const snapshot = await host.readSession(sessionId);
        if (activeSessionIdRef.current !== sessionId) return;
        const snapshotScope = { directory: snapshot.projectDirectory, sessionId };
        if (snapshotScope.directory !== scope.directory) transcriptStore.select(snapshotScope);
        activeSnapshotRef.current = snapshot;
        activeStreamRef.current = createHostTranscriptStream(snapshot);
        setSelectedModel(selectedModelFromHostSnapshot(snapshot));
        if (snapshot.reasoning) setReasoningEffortState(snapshot.reasoning);
        const messages = projectHostSnapshotToMessages(snapshot);
        transcriptStore.dispatch({
          type: "page.loaded",
          scope: snapshotScope,
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
      } finally {
        hydratingSessionIdsRef.current.delete(sessionId);
      }
    },
    [host, transcriptStore],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!host) {
        replaceProjects([]);
        setSessions([]);
        setBootState("idle");
        return;
      }
      try {
        setBootState("checking-server");
        await host.health();
        if (cancelled) return;
        await refreshModels();
        const directories = await refreshProjects();
        await refreshSessions(directories);
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
  }, [host, refreshModels, refreshProjects, refreshSessions, replaceProjects]);

  useEffect(() => {
    if (!host) return;
    if (!activeSessionId) {
      void hydrateTranscript(null);
      return;
    }
    if (activeStreamRef.current?.snapshot.id === activeSessionId) return;
    void hydrateTranscript(activeSessionId);
  }, [activeSessionId, hydrateTranscript]);

  const setActiveSnapshot = useCallback((snapshot: HostSessionSnapshot) => {
    activeSnapshotRef.current = snapshot;
  }, []);
  useHostEventStream({
    host,
    activeSessionIdRef,
    activeStreamRef,
    setActiveSnapshot,
    setBusySessionIds,
    transcriptStore,
    refreshSessions,
    hydrateTranscript,
    onFollowUpDispatched: (sessionId, followUpId) =>
      queueController?.recordDispatched(sessionId, followUpId),
  });

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

  const workspaceValue = useMemo<WorkspaceContextValue>(
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
      workspace,
      workspaces,
      activeWorkspaceId,
      policy,
    ],
  );

  const actions = useHostActions(() => {
    const connectToProject = async (directory: string) => {
      if (!host) throw new Error("Connect to an OpenGUI Host first");
      const normalized = normalizeProjectPath(directory);
      await host.registerProject(normalized);
      const nextProjects = projects.includes(normalized) ? projects : [normalized, ...projects];
      replaceProjects(nextProjects);
      setActiveTargetDirectory(normalized);
      await refreshSessions(nextProjects);
    };

    return {
      removeProject: async (directory) => {
        const normalized = normalizeProjectPath(directory);
        await requireHost().unregisterProject(normalized);
        const nextProjects = projects.filter((item) => item !== normalized);
        replaceProjects(nextProjects);
        if (activeTargetDirectory === normalized) {
          setActiveTargetDirectory(null);
          activeSessionIdRef.current = null;
          setActiveSessionId(null);
        }
        await refreshSessions(nextProjects);
      },
      selectSession: async (id) => {
        activeSessionIdRef.current = id;
        setActiveSessionId(id);
        if (id) {
          const session = sessions.find((item) => item.id === id);
          if (session?.directory) setActiveTargetDirectory(session.directory);
        }
      },
      loadOlderMessages: async () => false,
      deleteSession: async (id) => {
        await requireHost().deleteSession(id);
        if (activeSessionId === id) {
          activeSessionIdRef.current = null;
          setActiveSessionId(null);
        }
        await refreshSessions();
      },
      renameSession: async (id, title) => {
        await requireHost().renameSession(id, title);
        await refreshSessions();
      },
      sendPrompt: async (text) => {
        let optimisticMessage: {
          scope: { directory: string; sessionId: string };
          id: string;
        } | null = null;
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
            await refreshSessions();
          } else {
            const session = sessions.find((item) => item.id === sessionId);
            if (shouldAutoNameSession(session)) {
              await requireHost().renameSession(sessionId, text.trim());
              await refreshSessions();
            }
          }
          const optimisticMessageId = `optimistic:${sessionId}:${Date.now()}`;
          const scope = { directory, sessionId };
          if (!busySessionIds.has(sessionId)) {
            optimisticMessage = { scope, id: optimisticMessageId };
            transcriptStore.dispatch({
              type: "message.appended",
              scope,
              message: {
                info: {
                  id: optimisticMessageId,
                  sessionID: sessionId,
                  role: "user",
                  providerID: selectedModel?.providerID ?? "",
                  modelID: selectedModel?.modelID ?? "",
                  time: { created: Date.now() },
                },
                parts: [
                  {
                    id: `${optimisticMessageId}:text`,
                    type: "text",
                    text,
                    sessionID: sessionId,
                    messageID: optimisticMessageId,
                    tokens: {},
                  },
                ],
              },
            });
          }
          setBusySessionIds((current) => new Set(current).add(sessionId!));
          const result = await requireHost().prompt(sessionId, text);
          if (result.mode === "follow_up") {
            transcriptStore.dispatch({
              type: "message.removed",
              scope,
              messageId: optimisticMessageId,
            });
            queueController?.recordEnqueued(sessionId, result.followUp);
          } else {
            let stream = activeStreamRef.current;
            if (stream?.snapshot.id === sessionId) {
              for (const entry of result.startedEntries) {
                stream = applyHostTranscriptEvent(stream, {
                  sessionId,
                  event: { type: "entry_appended", entry },
                });
              }
              activeStreamRef.current = stream;
              activeSnapshotRef.current = stream.snapshot;
              transcriptStore.dispatch({
                type: "page.loaded",
                scope: { directory: stream.snapshot.projectDirectory, sessionId },
                phase: "initial",
                messages: projectHostTranscriptStream(stream),
                hasMore: false,
                nextCursor: null,
              });
            }
          }
        } catch (error) {
          if (optimisticMessage) {
            transcriptStore.dispatch({
              type: "message.removed",
              scope: optimisticMessage.scope,
              messageId: optimisticMessage.id,
            });
          }
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
      setModel: async (model) => {
        const previous = selectedModel;
        setSelectedModel(model);
        if (!model) return;
        try {
          const snapshot = await persistHostModelSelection(requireHost(), activeSessionId, model);
          if (snapshot) activeSnapshotRef.current = snapshot;
        } catch (error) {
          setSelectedModel(previous);
          notifyUnknownError(error);
        }
      },
      setPromptBoxSelection: async ({ model }) => {
        const previous = selectedModel;
        setSelectedModel(model);
        if (!model) return;
        try {
          const snapshot = await persistHostModelSelection(requireHost(), activeSessionId, model);
          if (snapshot) activeSnapshotRef.current = snapshot;
        } catch (error) {
          setSelectedModel(previous);
          notifyUnknownError(error);
        }
      },
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
      removeFromQueue: (sessionId, promptId) => {
        void queueController?.remove(sessionId, promptId).catch(notifyUnknownError);
      },
      reorderQueue: (sessionId, fromIndex, toIndex) => {
        void queueController?.reorder(sessionId, fromIndex, toIndex).catch(notifyUnknownError);
      },
      updateQueuedPrompt: (sessionId, promptId, text) => {
        void queueController?.update(sessionId, promptId, text).catch(notifyUnknownError);
      },
      sendQueuedNow: async (sessionId, promptId) => {
        await queueController?.sendNow(sessionId, promptId);
      },
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
        activeSessionIdRef.current = created.id;
        await refreshSessions();
        await hydrateTranscript(created.id);
      },
      setActiveTarget: (directory) => {
        setActiveTargetDirectory(normalizeProjectPath(directory));
        activeSessionIdRef.current = null;
        setActiveSessionId(null);
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
        replaceProjects([]);
        setSessions([]);
        activeSessionIdRef.current = null;
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
        replaceProjects([]);
        setSessions([]);
        activeSessionIdRef.current = null;
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
      reorderVisibleProjects: replaceProjects,
    };
  }, [
    activeSessionId,
    activeTargetDirectory,
    detachedProject,
    host,
    hydrateTranscript,
    queuedPrompts,
    refreshModels,
    replaceProjects,
    requireHost,
    refreshSessions,
    effectiveReasoningEffort,
    reasoningEffort,
    selectedModel,
    sessions,
    projects,
    workspaces,
    activeWorkspaceId,
  ]);

  return (
    <SessionContext.Provider value={sessionValue}>
      <ModelContext.Provider value={modelValue}>
        <WorkspaceContext.Provider value={workspaceValue}>
          <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
        </WorkspaceContext.Provider>
      </ModelContext.Provider>
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
