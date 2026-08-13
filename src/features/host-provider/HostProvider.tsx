import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SelectedModel } from "@opengui/protocol";
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
  getActiveWorkspace,
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
  useActiveTranscriptSnapshot,
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
import { defaultEnabledSkillNames, sessionSkillsKey } from "@/lib/session-skills";
import { findModel } from "@/lib/utils";
import {
  createSessionProjectDetachMeta,
  createSessionProjectMoveMeta,
  makeProjectKey,
  shouldAutoNameSession,
} from "@/hooks/agent-session-utils";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageSet } from "@/lib/persistence/storage";
import { connectionsToModelProviders } from "@/lib/models-dev";
import { notifyError, notifyUnknownError } from "@/lib/notify";
import { getDesktopShellClient } from "@/runtime/clients";
import {
  applyHostModelSnapshot,
  selectedModelFromHostSnapshot,
} from "@/features/host-provider/host-session-selection";
import { persistHostModelSelection } from "@/features/host-provider/host-model-selection";
import { loadHostSessionSummaries } from "@/features/host-provider/host-session-list";
import { createOptimisticUserMessage } from "@/features/host-provider/host-optimistic-message";
import {
  resolveRestoredSessionId,
  useHostSlice,
  type ModelSlice,
  type ProjectSlice,
  type SessionSlice,
  type TransportSlice,
  type WorkspaceSlice,
} from "@/features/host-provider/host-domain-state";
import { useHostEventStream } from "@/features/host-provider/host-event-stream";
import {
  HostQueueController,
  projectHostFollowUps,
  useHostActions,
} from "@/features/host-provider/host-actions";
import { announceIdentityWorkspaceChange } from "@/features/identity/workspace-identity";
import {
  snapshotIdentityActor,
  useIdentityActor,
} from "@/features/identity/identity-actor-context";

function lockedSkillsFromSnapshot(snapshot: HostSessionSnapshot): string[] | null {
  for (const entry of snapshot.entries) {
    if (entry.kind !== "user_message") continue;
    const skills = entry.payload.skills;
    if (!Array.isArray(skills)) continue;
    return skills
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return null;
}

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
    _accessRole: summary.accessRole,
    _shared: summary.shared,
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
          // The main process owns Local Host authorization. Never send its
          // credential back across the renderer-controlled request envelope.
          headers.delete("authorization");
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
  if (policy.shellKind === "web") return stored.length > 0 ? stored : [createLocalWorkspace()];
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
  const { t } = useTranslation();
  const transcriptStore = useActiveTranscriptStore();
  const identityActor = useIdentityActor();
  const currentActor = useMemo(() => snapshotIdentityActor(identityActor), [identityActor]);
  const policy = useMemo(() => getShellWorkspacePolicy(), []);
  const workspaceSlice = useHostSlice<WorkspaceSlice>(() => {
    const workspaces = initialWorkspaces();
    return { workspaces, activeWorkspaceId: getActiveWorkspaceId(workspaces) };
  });
  const { workspaces, activeWorkspaceId } = workspaceSlice.state;
  const setWorkspaces = workspaceSlice.setter("workspaces");
  const setActiveWorkspaceId = workspaceSlice.setter("activeWorkspaceId");
  const workspace = getActiveWorkspace(workspaces, activeWorkspaceId);
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
  /** Per-session/pending skill allowlists. Locked once the session has messages. */
  const [enabledSkillsByKey, setEnabledSkillsByKey] = useState<Record<string, string[]>>({});
  const enabledSkillsByKeyRef = useRef(enabledSkillsByKey);
  enabledSkillsByKeyRef.current = enabledSkillsByKey;
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
  const modelSelectionRevisionRef = useRef(0);
  const modelSelectionMutationRef = useRef<Promise<void>>(Promise.resolve());
  const queuedPromptsRef = useRef(queuedPrompts);
  /** Steer (after-part) Follow-ups waiting for the current model part to end. */
  const afterPartFollowUpsRef = useRef<Record<string, string[]>>({});
  const steeringSessionIdsRef = useRef(new Set<string>());

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

  const rememberActiveSession = useCallback(
    (sessionId: string | null) => {
      persistWorkspaces(
        workspaces.map((item) =>
          item.id === activeWorkspaceId
            ? normalizeWorkspace({
                ...item,
                lastActiveSessionId: sessionId,
                settings: { ...item.settings, lastActiveSessionId: sessionId },
              })
            : item,
        ),
      );
    },
    [activeWorkspaceId, workspaces],
  );

  const refreshModels = useCallback(async () => {
    if (!host) return;
    const [listedConnections, offerings] = await Promise.all([
      host.listModelConnections(),
      host.listModelOfferings?.() ?? Promise.resolve([]),
    ]);
    const personalConnections = listedConnections.filter(
      (connection) => connection.plane === "user",
    );
    const offeringConnection =
      offerings.length > 0
        ? [
            {
              id: "opengui-offering",
              label: "OpenGUI",
              baseUrl: "",
              modelIds: offerings.map((offering) => offering.id),
              defaultModelId: offerings[0]?.id,
              modelCapabilities: Object.fromEntries(
                offerings.map((offering) => [
                  offering.id,
                  { displayName: offering.displayName, reasoning: true },
                ]),
              ),
            },
          ]
        : [];
    const connections =
      offeringConnection.length > 0
        ? [...offeringConnection, ...personalConnections]
        : listedConnections;
    const nextProviders = await connectionsToModelProviders(connections);
    setProviders(nextProviders);
    const defaultModelId = connections[0]?.defaultModelId ?? connections[0]?.modelIds[0];
    setSelectedModel((current) => {
      const stillVisible =
        current &&
        connections.some(
          (connection) =>
            connection.id === current.providerID && connection.modelIds.includes(current.modelID),
        );
      if (stillVisible) return current;
      return connections[0] && defaultModelId
        ? { providerID: connections[0].id, modelID: defaultModelId }
        : null;
    });
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
      const restoredSessionId = resolveRestoredSessionId(
        activeSessionIdRef.current,
        workspace?.lastActiveSessionId,
        listed.map((item) => item.id),
      );
      if (restoredSessionId !== activeSessionIdRef.current) {
        activeSessionIdRef.current = restoredSessionId;
        setActiveSessionId(restoredSessionId);
      }
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
    [activeWorkspaceId, host, workspace?.lastActiveSessionId],
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
        modelSelectionRevisionRef.current += 1;
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
        // Lock skill selection to the first turn's allowlist when present so
        // reloads keep the same catalog for prompt-cache stability.
        if (messages.length > 0) {
          const key = sessionSkillsKey(sessionId, null);
          if (key) {
            const locked = lockedSkillsFromSnapshot(snapshot);
            if (locked) {
              setEnabledSkillsByKey((current) =>
                current[key] ? current : { ...current, [key]: locked },
              );
            }
          }
        }
        setQueuedPrompts((current) => ({
          ...current,
          [sessionId]: projectHostFollowUps(snapshot.followUps),
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

  const forgetAfterPartFollowUp = useCallback((sessionId: string, followUpId: string) => {
    const pending = afterPartFollowUpsRef.current[sessionId];
    if (!pending?.length) return;
    const next = pending.filter((id) => id !== followUpId);
    if (next.length === pending.length) return;
    if (next.length === 0) delete afterPartFollowUpsRef.current[sessionId];
    else afterPartFollowUpsRef.current[sessionId] = next;
  }, []);

  const dispatchAfterPartSteer = useCallback(
    (sessionId: string) => {
      const followUpId = afterPartFollowUpsRef.current[sessionId]?.[0];
      if (!followUpId || steeringSessionIdsRef.current.has(sessionId)) return;
      steeringSessionIdsRef.current.add(sessionId);
      void (async () => {
        try {
          await queueController?.sendNow(sessionId, followUpId);
          forgetAfterPartFollowUp(sessionId, followUpId);
          if (activeSessionIdRef.current === sessionId) {
            await hydrateTranscript(sessionId);
          }
        } catch {
          // Run may have completed and already claimed this Follow-up as FIFO.
          forgetAfterPartFollowUp(sessionId, followUpId);
        } finally {
          steeringSessionIdsRef.current.delete(sessionId);
        }
      })();
    },
    [forgetAfterPartFollowUp, hydrateTranscript, queueController],
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
    activeSessionId,
    activeSessionIdRef,
    activeStreamRef,
    setActiveSnapshot,
    setBusySessionIds,
    transcriptStore,
    refreshSessions,
    hydrateTranscript,
    onFollowUpDispatched: (sessionId, followUpId) => {
      forgetAfterPartFollowUp(sessionId, followUpId);
      queueController?.recordDispatched(sessionId, followUpId);
    },
    onModelPartEnded: (sessionId) => dispatchAfterPartSteer(sessionId),
  });

  const activeTranscript = useActiveTranscriptSnapshot();
  const activeSkillsKey = useMemo(
    () => sessionSkillsKey(activeSessionId, activeTargetDirectory),
    [activeSessionId, activeTargetDirectory],
  );
  const skillsLocked = Boolean(
    activeSessionId &&
    (busySessionIds.has(activeSessionId) ||
      (activeTranscript.scope?.sessionId === activeSessionId &&
        activeTranscript.messages.length > 0)),
  );
  const enabledSkillNames = activeSkillsKey ? (enabledSkillsByKey[activeSkillsKey] ?? []) : [];

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
            mode: item.mode,
            createdAt: Date.now(),
            actor: item.actor,
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
      enabledSkillNames,
      skillsLocked,
    }),
    [
      activeSessionId,
      activeTargetDirectory,
      busySessionIds,
      enabledSkillNames,
      queuedPrompts,
      sessionDrafts,
      sessionMeta,
      sessions,
      skillsLocked,
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
      commands: [{ name: "compact" }],
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

  const persistSelectedModel = useCallback(
    (model: SelectedModel | null) => {
      const previous = selectedModel;
      const sessionId = activeSessionId;
      const revision = ++modelSelectionRevisionRef.current;
      setSelectedModel(model);
      if (!model) return Promise.resolve();

      const mutation = modelSelectionMutationRef.current
        .catch(() => undefined)
        .then(async () => {
          try {
            const snapshot = await persistHostModelSelection(requireHost(), sessionId, model);
            if (!snapshot) return;
            setSessions((current) => applyHostModelSnapshot(current, snapshot));
            if (activeSessionIdRef.current === snapshot.id) {
              activeSnapshotRef.current = snapshot;
            }
            if (
              revision === modelSelectionRevisionRef.current &&
              activeSessionIdRef.current === snapshot.id
            ) {
              setSelectedModel(selectedModelFromHostSnapshot(snapshot));
            }
          } catch (error) {
            if (revision === modelSelectionRevisionRef.current) setSelectedModel(previous);
            notifyUnknownError(error);
          }
        });
      modelSelectionMutationRef.current = mutation;
      return mutation;
    },
    [activeSessionId, requireHost, selectedModel],
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

    const compactActiveSession = async () => {
      if (!activeSessionId) throw new Error(t("compaction.selectSession"));
      setBusySessionIds((current) => new Set(current).add(activeSessionId));
      try {
        await requireHost().compact(activeSessionId);
        await hydrateTranscript(activeSessionId);
        await refreshSessions();
      } catch (error) {
        setBusySessionIds((current) => {
          const next = new Set(current);
          next.delete(activeSessionId);
          return next;
        });
        throw error;
      }
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
        rememberActiveSession(id);
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
          rememberActiveSession(null);
        }
        await refreshSessions();
      },
      renameSession: async (id, title) => {
        await requireHost().renameSession(id, title);
        await refreshSessions();
      },
      sendPrompt: async (text, mode, submittedSkills) => {
        // The caller captures the visible selection at submit time. Normalize it
        // before any asynchronous Session creation/refresh can change active keys.
        const submittedAllowlist =
          submittedSkills === undefined
            ? undefined
            : Array.from(
                new Set(
                  submittedSkills.map((name) => name.trim()).filter((name) => name.length > 0),
                ),
              );
        // Steer is after-part. interrupt remains available for programmatic send-now paths.
        const queueMode = mode === "after-part" || mode === "interrupt" ? mode : "queue";
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
            rememberActiveSession(sessionId);
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
              message: createOptimisticUserMessage({
                id: optimisticMessageId,
                sessionId,
                text,
                actor: currentActor,
                providerId: selectedModel?.providerID,
                modelId: selectedModel?.modelID,
                createdAt: Date.now(),
              }),
            });
          }
          setBusySessionIds((current) => new Set(current).add(sessionId!));
          // Prefer the session key; if this was a pending new chat, migrate the
          // pending allowlist onto the created Session so later turns stay stable.
          const pendingKey = sessionSkillsKey(null, directory);
          const sessionKey = sessionSkillsKey(sessionId, null);
          let skillsAllowlist: string[] | undefined;
          if (sessionKey) {
            const map = enabledSkillsByKeyRef.current;
            if (submittedAllowlist !== undefined) {
              // This is authoritative: it is the selection rendered beside the
              // prompt at the instant the user submitted.
              skillsAllowlist = submittedAllowlist;
              enabledSkillsByKeyRef.current = {
                ...map,
                [sessionKey]: submittedAllowlist,
              };
              setEnabledSkillsByKey((current) => {
                const next = { ...current, [sessionKey]: submittedAllowlist };
                if (pendingKey) delete next[pendingKey];
                return next;
              });
            } else if (Object.hasOwn(map, sessionKey)) {
              skillsAllowlist = map[sessionKey];
            } else if (pendingKey && Object.hasOwn(map, pendingKey)) {
              skillsAllowlist = map[pendingKey];
              setEnabledSkillsByKey((current) => {
                const next = { ...current, [sessionKey]: current[pendingKey]! };
                delete next[pendingKey];
                return next;
              });
            } else {
              // Non-UI callers retain auto-on/manual-off defaults.
              try {
                const discovered = await requireHost().listSkills(directory);
                skillsAllowlist = defaultEnabledSkillNames(discovered);
                setEnabledSkillsByKey((current) =>
                  Object.hasOwn(current, sessionKey)
                    ? current
                    : { ...current, [sessionKey]: skillsAllowlist! },
                );
              } catch {
                // Fall through to Host defaults if discovery fails.
              }
            }
          }
          const result = await requireHost().prompt(sessionId, text, {
            ...(skillsAllowlist !== undefined ? { skills: skillsAllowlist } : {}),
            // interrupt = send immediately (used by send-now). Steer/after-part queues
            // and dispatches when the current model part ends.
            ...(queueMode === "interrupt" ? { interrupt: true } : {}),
          });
          if (result.mode === "follow_up") {
            if (optimisticMessage) {
              transcriptStore.dispatch({
                type: "message.removed",
                scope,
                messageId: optimisticMessageId,
              });
            }
            const followUpMode = queueMode === "after-part" ? "after-part" : "queue";
            queueController?.recordEnqueued(sessionId, result.followUp, followUpMode);
            if (followUpMode === "after-part") {
              const pending = afterPartFollowUpsRef.current[sessionId] ?? [];
              afterPartFollowUpsRef.current[sessionId] = [...pending, result.followUp.id];
            }
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
            if (queueMode === "interrupt") {
              await hydrateTranscript(sessionId);
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
      listSkills: async (directory) => requireHost().listSkills(directory),
      searchSessionMessages: async (directory, query) =>
        requireHost().searchSessionMessages(directory, query),
      ensureSessionSkills: (skills) => {
        const key = sessionSkillsKey(activeSessionId, activeTargetDirectory);
        if (!key) return;
        // Never invent a mutable selection after the Session has started.
        const locked =
          Boolean(activeSessionId) &&
          ((activeSessionId ? busySessionIds.has(activeSessionId) : false) ||
            (activeTranscript.scope?.sessionId === activeSessionId &&
              activeTranscript.messages.length > 0));
        if (locked) return;
        setEnabledSkillsByKey((current) => {
          if (Object.hasOwn(current, key)) return current;
          return { ...current, [key]: defaultEnabledSkillNames(skills) };
        });
      },
      toggleSessionSkill: (name, catalog = []) => {
        const trimmed = name.trim();
        const key = sessionSkillsKey(activeSessionId, activeTargetDirectory);
        if (!trimmed || !key) return;
        const locked =
          Boolean(activeSessionId) &&
          ((activeSessionId ? busySessionIds.has(activeSessionId) : false) ||
            (activeTranscript.scope?.sessionId === activeSessionId &&
              activeTranscript.messages.length > 0));
        if (locked) return;
        setEnabledSkillsByKey((current) => {
          const baseline = Object.hasOwn(current, key)
            ? current[key]!
            : defaultEnabledSkillNames(catalog);
          const next = baseline.includes(trimmed)
            ? baseline.filter((item) => item !== trimmed)
            : [...baseline, trimmed];
          return { ...current, [key]: next };
        });
      },
      sendCommand: async (command, args) => {
        if (command !== "compact") {
          throw new Error(t("compaction.unsupportedCommand", { command }));
        }
        if (args.trim()) throw new Error(t("compaction.noArguments"));
        await compactActiveSession();
      },
      summarizeSession: async () => {
        await compactActiveSession();
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
      setModel: persistSelectedModel,
      setPromptBoxSelection: ({ model }) => persistSelectedModel(model),
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
          mode: item.mode,
          createdAt: Date.now(),
          actor: item.actor,
        })),
      removeFromQueue: (sessionId, promptId) => {
        forgetAfterPartFollowUp(sessionId, promptId);
        void queueController?.remove(sessionId, promptId).catch(notifyUnknownError);
      },
      reorderQueue: (sessionId, fromIndex, toIndex) => {
        void queueController?.reorder(sessionId, fromIndex, toIndex).catch(notifyUnknownError);
      },
      updateQueuedPrompt: (sessionId, promptId, text) => {
        void queueController?.update(sessionId, promptId, text).catch(notifyUnknownError);
      },
      sendQueuedNow: async (sessionId, promptId) => {
        forgetAfterPartFollowUp(sessionId, promptId);
        await queueController?.sendNow(sessionId, promptId);
        // send-now aborts the live Run then starts a new one. Rehydrate so any
        // in-flight stream buffers cannot leave ghost assistant rows behind.
        if (activeSessionIdRef.current === sessionId) {
          await hydrateTranscript(sessionId);
        }
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
      moveSessionToProject: async (sessionId, directory) => {
        const session = sessions.find((item) => item.id === sessionId);
        setSessionMeta((current) => {
          const meta = createSessionProjectMoveMeta(session, current[sessionId], directory);
          if (!meta) return current;
          const next = { ...current, [sessionId]: { ...current[sessionId], ...meta } };
          persistSessionMetaMap(next);
          return next;
        });
      },
      removeSessionFromProject: async (sessionId) => {
        const session = sessions.find((item) => item.id === sessionId);
        setSessionMeta((current) => {
          const meta = createSessionProjectDetachMeta(session, current[sessionId]);
          if (!meta) return current;
          const next = { ...current, [sessionId]: { ...current[sessionId], ...meta } };
          persistSessionMetaMap(next);
          return next;
        });
      },
      setProjectPinned: (directory, pinned) => {
        const projectKey = makeProjectKey(activeWorkspaceId, directory);
        setProjectMeta((current) => {
          const next = {
            ...current,
            [projectKey]: {
              ...current[projectKey],
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
        if (!persistWorkspaces(next)) return;
        setWorkspaces(next);
        setActiveWorkspaceId(nextWorkspace.id);
        storageSet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, nextWorkspace.id);
        announceIdentityWorkspaceChange();
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
        if (!persistWorkspaces(next)) return;
        setWorkspaces(next);
        if (workspaceId === activeWorkspaceId) announceIdentityWorkspaceChange();
      },
      removeWorkspace: async (workspaceId) => {
        if (workspaceId === LOCAL_WORKSPACE_ID) return;
        const next = workspaces.filter((item) => item.id !== workspaceId);
        if (!persistWorkspaces(next)) return;
        setWorkspaces(next);
        if (activeWorkspaceId === workspaceId) {
          const fallback = next[0]?.id ?? "";
          setActiveWorkspaceId(fallback);
          storageSet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, fallback);
          announceIdentityWorkspaceChange();
        }
      },
      switchWorkspace: (workspaceId) => {
        if (!workspaces.some((item) => item.id === workspaceId)) return;
        setActiveWorkspaceId(workspaceId);
        storageSet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, workspaceId);
        announceIdentityWorkspaceChange();
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
        if (!persistWorkspaces(next)) return;
        setWorkspaces(next);
      },
      reorderVisibleProjects: replaceProjects,
    };
  }, [
    activeSessionId,
    activeTargetDirectory,
    activeTranscript.messages.length,
    activeTranscript.scope?.sessionId,
    busySessionIds,
    detachedProject,
    currentActor,
    forgetAfterPartFollowUp,
    host,
    hydrateTranscript,
    rememberActiveSession,
    queuedPrompts,
    queueController,
    refreshModels,
    replaceProjects,
    requireHost,
    refreshSessions,
    effectiveReasoningEffort,
    reasoningEffort,
    selectedModel,
    persistSelectedModel,
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
