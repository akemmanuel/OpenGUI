import type { PermissionRequest, QuestionRequest } from "@/protocol/harness-types";
import type { InternalAgentState, QueuedPrompt } from "@/hooks/agent-state-types";
import { getSessionWorkspaceId, parseProjectKey } from "@/hooks/agent-session-utils";
import {
  normalizeWorkspace,
  persistProjectMetaMap,
  persistWorktreeParents,
  type WorktreeParentMap,
} from "@/hooks/agent-state-persistence";
import { prependProjectIfMissing } from "@/lib/sidebar-order";
import { normalizeProjectPath } from "@/lib/utils";
import type { Action } from "@/hooks/agent-reducer-types";

const WORKSPACE_ACTION_TYPES = new Set<string>([
  "SET_WORKSPACES",
  "ADD_WORKSPACE_PROJECT",
  "SET_ACTIVE_WORKSPACE",
  "REORDER_WORKSPACES",
  "REORDER_VISIBLE_WORKSPACE_PROJECTS",
  "ASSIGN_PROJECT_WORKSPACE",
  "SET_PROJECT_CONNECTION",
  "SET_PROJECT_HYDRATION",
  "RESET_PROJECT_HYDRATION",
  "REMOVE_PROJECT",
  "SET_WORKSPACE_RESOURCES",
  "ACTIVATE_WORKSPACE_RESOURCES",
  "EVICT_WORKSPACE_RESOURCES",
  "SET_PROVIDERS",
  "SET_SELECTED_MODEL",
  "SET_PROMPT_BOX_SELECTION",
  "SET_AGENTS",
  "SET_COMMANDS",
  "SET_SELECTED_AGENT",
  "SET_VARIANT_SELECTIONS",
  "SET_DEFAULT_CHAT_DIRECTORY",
  "SET_ACTIVE_TARGET",
  "CLEAR_ACTIVE_TARGET",
  "SET_PROJECT_META",
  "REGISTER_WORKTREE",
  "UNREGISTER_WORKTREE",
  "SET_PENDING_WORKTREE_CLEANUP",
]);

export function isWorkspaceReducerAction(action: Action): boolean {
  return WORKSPACE_ACTION_TYPES.has(action.type);
}

/** Phase C1: workspaces, projects, connections, hydration, resource cache, meta, worktrees, prompt targeting. */
export function reduceWorkspaceSlice(
  state: InternalAgentState,
  action: Action,
): InternalAgentState {
  switch (action.type) {
    case "SET_WORKSPACES":
      return {
        ...state,
        workspaces: action.payload.map((workspace) => normalizeWorkspace(workspace)),
      };

    case "ADD_WORKSPACE_PROJECT": {
      const {
        workspaceId,
        directory: rawDirectory,
        serverUrl,
        username,
        password,
      } = action.payload;
      const directory = normalizeProjectPath(rawDirectory);
      let changed = false;
      const nextWorkspaces = state.workspaces.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        changed = true;
        const projects = workspace.projects ?? [];
        return normalizeWorkspace({
          ...workspace,
          serverUrl,
          username: username ?? workspace.username,
          password: password ?? workspace.password,
          projects: prependProjectIfMissing(projects, directory),
        });
      });
      return changed ? { ...state, workspaces: nextWorkspaces } : state;
    }

    case "SET_ACTIVE_WORKSPACE": {
      const resources = state.workspaceResources[action.payload];
      return {
        ...state,
        activeWorkspaceId: action.payload,
        providers: resources?.providers ?? [],
        providerDefaults: resources?.providerDefaults ?? {},
        agents: resources?.agents ?? [],
        commands: resources?.commands ?? [],
        variantSelections: resources?.variantSelections ?? {},
      };
    }

    case "REORDER_WORKSPACES": {
      const { fromIndex, toIndex } = action.payload;
      if (state.workspaces.length <= 1) return state;
      if (fromIndex < 0 || fromIndex >= state.workspaces.length) return state;
      const clampedTo = Math.max(0, Math.min(toIndex, state.workspaces.length - 1));
      if (clampedTo === fromIndex) return state;
      const nextWorkspaces = [...state.workspaces];
      const [moved] = nextWorkspaces.splice(fromIndex, 1);
      if (!moved) return state;
      nextWorkspaces.splice(clampedTo, 0, moved);
      return { ...state, workspaces: nextWorkspaces };
    }

    case "REORDER_VISIBLE_WORKSPACE_PROJECTS": {
      const { workspaceId, orderedDirectories } = action.payload;
      const orderedSet = new Set(orderedDirectories);
      if (orderedSet.size <= 1) return state;
      let changed = false;
      const nextWorkspaces = state.workspaces.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const projects = workspace.projects ?? [];
        const projectSet = new Set(projects);
        const nextVisibleOrder = orderedDirectories.filter((directory) =>
          projectSet.has(directory),
        );
        const visibleProjectsInWorkspace = projects.filter((project) => orderedSet.has(project));
        if (visibleProjectsInWorkspace.length <= 1) return workspace;
        if (
          visibleProjectsInWorkspace.every((project, index) => project === nextVisibleOrder[index])
        ) {
          return workspace;
        }
        const nextOrderedProjects = [...nextVisibleOrder];
        const nextProjects = projects.map((project) =>
          orderedSet.has(project) ? (nextOrderedProjects.shift() ?? project) : project,
        );
        changed = true;
        return {
          ...workspace,
          projects: nextProjects,
        };
      });
      return changed ? { ...state, workspaces: nextWorkspaces } : state;
    }

    case "ASSIGN_PROJECT_WORKSPACE": {
      const { projectKey, workspaceId } = action.payload;
      const existing = state.projectWorkspaceMap[projectKey] ?? new Set();
      const updated = new Set(existing).add(workspaceId);
      return {
        ...state,
        projectWorkspaceMap: {
          ...state.projectWorkspaceMap,
          [projectKey]: updated,
        },
      };
    }

    case "SET_PROJECT_CONNECTION": {
      const { projectKey, status } = action.payload;
      const existing = state.connections[projectKey];
      return {
        ...state,
        connections: {
          ...state.connections,
          [projectKey]: {
            ...status,
            kind: status.kind ?? existing?.kind ?? "project",
          },
        },
      };
    }

    case "SET_PROJECT_HYDRATION": {
      const { projectKey, hydration } = action.payload;
      return {
        ...state,
        projectHydration: {
          ...state.projectHydration,
          [projectKey]: hydration,
        },
      };
    }

    case "RESET_PROJECT_HYDRATION": {
      return { ...state, projectHydration: {} };
    }

    case "REMOVE_PROJECT": {
      const { projectKey, directory } = action.payload;
      const { workspaceId } = parseProjectKey(projectKey);
      const isExplicitWorkspaceProject = state.workspaces.some(
        (workspace) => workspace.id === workspaceId && workspace.projects.includes(directory),
      );
      const removedSessionIds = new Set(
        state.sessions
          .filter((s) => {
            if (!isExplicitWorkspaceProject) return false;
            if (getSessionWorkspaceId(s) !== workspaceId) return false;
            const sessionDir = s._projectDir ?? s.directory;
            if (sessionDir !== directory) return false;
            const meta = state.sessionMeta[s.id];
            if (meta?.displayProjectDir && meta.displayProjectDir !== directory) return false;
            return true;
          })
          .map((s) => s.id),
      );
      const nextWorkspaces = state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              projects: workspace.projects.filter((project) => project !== directory),
            }
          : workspace,
      );
      const { [projectKey]: _, ...rest } = state.connections;
      const { [projectKey]: _removedHydration, ...restProjectHydration } = state.projectHydration;
      const { [projectKey]: _removedWorkspace, ...restProjectWorkspaceMap } =
        state.projectWorkspaceMap;
      const nextBusy = new Set(
        [...state.busySessionIds].filter((id) => !removedSessionIds.has(id)),
      );
      const nextPermissions: Record<string, PermissionRequest> = {};
      for (const [sid, value] of Object.entries(state.pendingPermissions)) {
        if (!removedSessionIds.has(sid)) nextPermissions[sid] = value;
      }
      const nextQuestions: Record<string, QuestionRequest> = {};
      for (const [sid, value] of Object.entries(state.pendingQuestions)) {
        if (!removedSessionIds.has(sid)) nextQuestions[sid] = value;
      }
      const nextQueues: Record<string, QueuedPrompt[]> = {};
      for (const [sid, value] of Object.entries(state.queuedPrompts)) {
        if (!removedSessionIds.has(sid)) nextQueues[sid] = value;
      }
      const nextUnread = new Set(
        [...state.unreadSessionIds].filter((id) => !removedSessionIds.has(id)),
      );

      const nextProjectMeta = { ...state.projectMeta };
      if (projectKey in nextProjectMeta) {
        delete nextProjectMeta[projectKey];
        persistProjectMetaMap(nextProjectMeta);
      }

      const nextNaming = new Set(state.namingSessionIds);
      for (const sessionId of removedSessionIds) {
        nextNaming.delete(sessionId);
      }

      return {
        ...state,
        workspaces: nextWorkspaces,
        projectMeta: nextProjectMeta,
        connections: rest,
        projectHydration: restProjectHydration,
        projectWorkspaceMap: restProjectWorkspaceMap,
        sessions: state.sessions.filter((s) => {
          if (!isExplicitWorkspaceProject) return true;
          if (getSessionWorkspaceId(s) !== workspaceId) return true;
          const sessionDir = s._projectDir ?? s.directory;
          if (sessionDir !== directory) return true;
          const meta = state.sessionMeta[s.id];
          if (meta?.displayProjectDir && meta.displayProjectDir !== directory) return true;
          return false;
        }),
        busySessionIds: nextBusy,
        namingSessionIds: nextNaming,
        unreadSessionIds: nextUnread,
        pendingPermissions: nextPermissions,
        pendingQuestions: nextQuestions,
        queuedPrompts: nextQueues,
        ...(state.activeSessionId && removedSessionIds.has(state.activeSessionId)
          ? {
              activeSessionId: null,
              isBusy: false,
            }
          : {}),
        activeTargetDirectory:
          state.activeTargetDirectory === directory ? null : state.activeTargetDirectory,
        activeTargetHarnessId:
          state.activeTargetDirectory === directory ? null : state.activeTargetHarnessId,
      };
    }

    case "SET_WORKSPACE_RESOURCES": {
      const { workspaceId, harnessId, projectKey, providersData, agentsData, commandsData } =
        action.payload;
      const resourceState = {
        providers: providersData.providers,
        providerDefaults: providersData.default,
        agents: agentsData,
        commands: commandsData,
        variantSelections: action.payload.variantSelections,
        loadedHarnessId: harnessId,
        loadedProjectKey: projectKey,
      };
      const isActive = workspaceId === state.activeWorkspaceId;
      return {
        ...state,
        workspaceResources: {
          ...state.workspaceResources,
          [workspaceId]: resourceState,
        },
        ...(isActive
          ? {
              providers: resourceState.providers,
              providerDefaults: resourceState.providerDefaults,
              agents: resourceState.agents,
              commands: resourceState.commands,
              variantSelections: resourceState.variantSelections,
            }
          : null),
      };
    }

    case "ACTIVATE_WORKSPACE_RESOURCES": {
      const resources = state.workspaceResources[action.payload.workspaceId];
      return {
        ...state,
        providers: resources?.providers ?? [],
        providerDefaults: resources?.providerDefaults ?? {},
        agents: resources?.agents ?? [],
        commands: resources?.commands ?? [],
        variantSelections: resources?.variantSelections ?? {},
      };
    }

    case "EVICT_WORKSPACE_RESOURCES": {
      const { [action.payload.workspaceId]: _removed, ...workspaceResources } =
        state.workspaceResources;
      const isActive = action.payload.workspaceId === state.activeWorkspaceId;
      return {
        ...state,
        workspaceResources,
        ...(isActive
          ? {
              providers: [],
              providerDefaults: {},
              agents: [],
              commands: [],
              variantSelections: {},
            }
          : null),
      };
    }

    case "SET_PROVIDERS":
      return {
        ...state,
        providers: action.payload.providers,
        providerDefaults: action.payload.default,
      };

    case "SET_SELECTED_MODEL":
      return { ...state, selectedModel: action.payload };

    case "SET_PROMPT_BOX_SELECTION":
      return {
        ...state,
        selectedModel: action.payload.model,
        ...(state.activeTargetDirectory && !state.activeSessionId
          ? { activeTargetHarnessId: action.payload.harnessId }
          : null),
      };

    case "SET_AGENTS":
      return { ...state, agents: action.payload };

    case "SET_COMMANDS":
      return { ...state, commands: action.payload };

    case "SET_SELECTED_AGENT":
      return { ...state, selectedAgent: action.payload };

    case "SET_VARIANT_SELECTIONS": {
      const activeWorkspaceId = state.activeWorkspaceId;
      const existing = state.workspaceResources[activeWorkspaceId];
      return {
        ...state,
        variantSelections: action.payload,
        workspaceResources: existing
          ? {
              ...state.workspaceResources,
              [activeWorkspaceId]: {
                ...existing,
                variantSelections: action.payload,
              },
            }
          : state.workspaceResources,
      };
    }

    case "SET_DEFAULT_CHAT_DIRECTORY":
      return { ...state, defaultChatDirectory: action.payload };

    case "SET_ACTIVE_TARGET":
      return {
        ...state,
        activeTargetDirectory: action.payload.directory,
        activeTargetHarnessId: action.payload.harnessId,
        activeSessionId: null,
        selectedModel: Object.hasOwn(action.payload, "selectedModel")
          ? (action.payload.selectedModel ?? null)
          : action.payload.resetSelection
            ? null
            : state.selectedModel,
        selectedAgent: Object.hasOwn(action.payload, "selectedAgent")
          ? (action.payload.selectedAgent ?? null)
          : action.payload.resetSelection
            ? null
            : state.selectedAgent,
        isBusy: false,
      };

    case "CLEAR_ACTIVE_TARGET":
      return {
        ...state,
        activeTargetDirectory: null,
        activeTargetHarnessId: null,
      };

    case "SET_PROJECT_META": {
      const { projectKey, meta } = action.payload;
      const nextMeta = { ...state.projectMeta };
      const existing = nextMeta[projectKey] ?? {};
      nextMeta[projectKey] = { ...existing, ...meta };
      persistProjectMetaMap(nextMeta);
      return { ...state, projectMeta: nextMeta };
    }

    case "REGISTER_WORKTREE": {
      const { worktreeDir, parentDir, branch } = action.payload;
      const now = new Date().toISOString();
      const next: WorktreeParentMap = {
        ...state.worktreeParents,
        [worktreeDir]: {
          parentDir,
          branch,
          createdAt: now,
          lastOpenedAt: now,
        },
      };
      persistWorktreeParents(next);
      return { ...state, worktreeParents: next };
    }

    case "UNREGISTER_WORKTREE": {
      const next = { ...state.worktreeParents };
      delete next[action.payload];
      persistWorktreeParents(next);
      return { ...state, worktreeParents: next };
    }

    case "SET_PENDING_WORKTREE_CLEANUP":
      return { ...state, pendingWorktreeCleanup: action.payload };

    default:
      return state;
  }
}
