import {
  createLocalWorkspace,
  getWorkspaceDefaultChatDirectory,
  type WorktreeParentMap,
} from "@/hooks/agent-state-persistence";
import {
  getWorkspaceRootProjectDirectory,
  listRelatedWorktreeDirectories,
} from "@/lib/worktree-placement";
import { makeProjectKey } from "@/hooks/agent-session-utils";
import type {
  ConnectionConfig,
  ConnectionKind,
  ConnectionStatus,
  Workspace,
} from "@/types/electron";
import { DEFAULT_SERVER_URL } from "@/lib/constants";
import { normalizeProjectPath } from "@/lib/utils";

type ProjectConfig = ConnectionConfig & {
  workspaceId: string;
  baseUrl: string;
  directory: string;
};

export type SessionListTargetSource = "workspace-project" | "default-chat";

export type SessionListTarget = ProjectConfig & {
  source: SessionListTargetSource;
};

export interface SessionIndexRootTarget {
  directory: string;
  source: SessionListTargetSource;
}

export interface ProjectConnectionDescriptor {
  workspaceId: string;
  directory: string;
  projectKey: string;
  config: ProjectConfig;
  target: {
    directory: string;
    workspaceId: string;
    baseUrl?: string;
    authToken?: string;
  };
}

function uniqueOrdered(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeDirectorySet(directories: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const directory of directories) {
    const normalized = normalizeProjectPath(directory);
    if (normalized) set.add(normalized);
  }
  return set;
}

export function createProjectConnectionStatus(
  state: ConnectionStatus["state"],
  serverUrl: string,
  kind: ConnectionKind = "project",
  error: string | null = null,
): ConnectionStatus {
  return {
    state,
    kind,
    serverUrl,
    serverVersion: null,
    error,
    lastEventAt: Date.now(),
  };
}

export function resolveConnectionWorkspace(
  workspaces: Workspace[],
  activeWorkspaceId: string,
): Workspace {
  return workspaces.find((item) => item.id === activeWorkspaceId) ?? createLocalWorkspace();
}

export function createWorkspaceProjectConnectionPlan({
  directory,
  workspaceId,
  worktreeParents,
  connectedDirectories = [],
}: {
  directory: string;
  workspaceId: string;
  worktreeParents: WorktreeParentMap;
  connectedDirectories?: Iterable<string>;
}) {
  const normalizedDirectory = normalizeProjectPath(directory);
  const rootDirectory = getWorkspaceRootProjectDirectory(normalizedDirectory, worktreeParents);
  const relatedWorktrees = listRelatedWorktreeDirectories(rootDirectory, worktreeParents);
  const desiredDirectories = uniqueOrdered([rootDirectory, ...relatedWorktrees]);
  const connectedSet = new Set(connectedDirectories);

  return {
    rootDirectory,
    relatedWorktrees,
    desiredDirectories,
    expectedProjectKeys: desiredDirectories.map((candidate) =>
      makeProjectKey(workspaceId, candidate),
    ),
    missingDirectories: desiredDirectories.filter((candidate) => !connectedSet.has(candidate)),
    workspaceProjectDirectory: rootDirectory,
    isWorktree: rootDirectory !== normalizedDirectory,
  };
}

export function createProjectRemovalPlan({
  directory,
  worktreeParents,
}: {
  directory: string;
  worktreeParents: WorktreeParentMap;
}) {
  const workspaceDirectory = getWorkspaceRootProjectDirectory(directory, worktreeParents);
  const directoriesToRemove =
    workspaceDirectory === directory
      ? [workspaceDirectory, ...listRelatedWorktreeDirectories(workspaceDirectory, worktreeParents)]
      : [directory];

  return {
    workspaceDirectory,
    directoriesToRemove: uniqueOrdered(directoriesToRemove),
  };
}

export function buildBootstrapProjectConfigs({
  workspaces,
  detachedProject,
  worktreeParents,
}: {
  workspaces: Workspace[];
  detachedProject?: string;
  worktreeParents: WorktreeParentMap;
}) {
  const bootWorkspaces = workspaces.map((workspace) =>
    workspace.isLocal && detachedProject
      ? { ...workspace, projects: [detachedProject] }
      : workspace,
  );
  const projectConfigs: SessionListTarget[] = [];
  const expectedProjectKeys: string[] = [];
  const seenProjectKeys = new Set<string>();

  for (const workspace of bootWorkspaces) {
    const indexRootTargets = getSessionIndexRootTargets(workspace);
    for (const target of indexRootTargets) {
      const plan = createWorkspaceProjectConnectionPlan({
        directory: target.directory,
        workspaceId: workspace.id,
        worktreeParents,
      });
      for (const projectKey of plan.expectedProjectKeys) {
        if (!seenProjectKeys.has(projectKey)) {
          seenProjectKeys.add(projectKey);
          expectedProjectKeys.push(projectKey);
        }
      }
      for (const directory of plan.desiredDirectories) {
        const projectKey = makeProjectKey(workspace.id, directory);
        if (
          projectConfigs.some(
            (config) => makeProjectKey(config.workspaceId, config.directory) === projectKey,
          )
        ) {
          continue;
        }
        projectConfigs.push({
          workspaceId: workspace.id,
          baseUrl: workspace.serverUrl,
          directory,
          username: workspace.username,
          password: workspace.password,
          authToken: workspace.authToken,
          source: target.source,
        });
      }
    }
  }

  return { projectConfigs, expectedProjectKeys };
}

/** Workspace projects plus default chat directory when it is not already a project. */
export function getSessionIndexRootDirectories(workspace: Workspace): string[] {
  return getSessionIndexRootTargets(workspace).map((target) => target.directory);
}

/**
 * Session list targets are not the same thing as visible Workspace Projects.
 * Projects take precedence: when the default chat path is already a Project, do
 * not classify existing Harness sessions from that path as chat-origin.
 */
export function getSessionIndexRootTargets(workspace: Workspace): SessionIndexRootTarget[] {
  const projectSet = normalizeDirectorySet(workspace.projects ?? []);
  const targets: SessionIndexRootTarget[] = Array.from(projectSet, (directory) => ({
    directory,
    source: "workspace-project",
  }));
  const defaultChat = getWorkspaceDefaultChatDirectory(workspace);
  if (defaultChat && !projectSet.has(defaultChat)) {
    targets.push({ directory: defaultChat, source: "default-chat" });
  }
  return targets;
}

export function createWorkspaceConnectionConfig({
  workspace,
  directory,
}: {
  workspace: Workspace;
  directory: string;
}): ConnectionConfig {
  return {
    workspaceId: workspace.id,
    baseUrl: workspace.serverUrl ?? DEFAULT_SERVER_URL,
    directory,
    username: workspace.username,
    password: workspace.password,
    authToken: workspace.authToken,
  };
}

export function createProjectConnectionDescriptor({
  config,
  workspaceId = config.workspaceId,
}: {
  config: ConnectionConfig;
  workspaceId?: string;
}): ProjectConnectionDescriptor {
  const directory = normalizeProjectPath(config.directory ?? "");
  const resolvedWorkspaceId = workspaceId || config.workspaceId || "";
  const resolvedConfig: ProjectConfig = {
    ...config,
    workspaceId: resolvedWorkspaceId,
    baseUrl: config.baseUrl,
    directory,
  };

  return {
    workspaceId: resolvedWorkspaceId,
    directory,
    projectKey: makeProjectKey(resolvedWorkspaceId, directory),
    config: resolvedConfig,
    target: {
      directory,
      workspaceId: resolvedWorkspaceId,
      baseUrl: resolvedConfig.baseUrl,
      authToken: resolvedConfig.authToken,
    },
  };
}

export function shouldPersistWorkspaceProject(options?: { hidden?: boolean; transient?: boolean }) {
  return !options?.hidden && !options?.transient;
}

export type WorkspaceProjectPersistPlan = {
  addWorkspaceProject: {
    workspaceId: string;
    directory: string;
    serverUrl: string;
    username?: string;
    password?: string;
  } | null;
  persistLocalConnectionSettings: boolean;
  serverUrl: string;
  username?: string;
};

/** Promote a directory to a persisted Workspace Project (independent of Harness hydration). */
export function buildWorkspaceProjectPersistPlan({
  directory,
  workspaceId,
  worktreeParents,
  workspace,
  config,
  options,
}: {
  directory: string;
  workspaceId: string;
  worktreeParents: WorktreeParentMap;
  workspace: Workspace;
  config: ConnectionConfig;
  options?: { hidden?: boolean; transient?: boolean };
}): WorkspaceProjectPersistPlan | null {
  if (!shouldPersistWorkspaceProject(options)) return null;
  const connectionPlan = createWorkspaceProjectConnectionPlan({
    directory,
    workspaceId,
    worktreeParents,
  });
  const workspaceProjectDirectory = connectionPlan.workspaceProjectDirectory;
  if (!workspaceProjectDirectory) {
    return {
      addWorkspaceProject: null,
      persistLocalConnectionSettings: shouldPersistLocalConnectionSettings(
        workspace.isLocal,
        options,
      ),
      serverUrl: config.baseUrl,
      username: config.username,
    };
  }
  return {
    addWorkspaceProject: {
      workspaceId,
      directory: workspaceProjectDirectory,
      serverUrl: config.baseUrl,
      username: config.username,
      password: config.password,
    },
    persistLocalConnectionSettings: shouldPersistLocalConnectionSettings(
      workspace.isLocal,
      options,
    ),
    serverUrl: config.baseUrl,
    username: config.username,
  };
}

export function shouldPersistLocalConnectionSettings(
  workspaceOrIsLocal: boolean | string,
  options?: { hidden?: boolean; transient?: boolean },
) {
  const isLocalWorkspace =
    typeof workspaceOrIsLocal === "boolean" ? workspaceOrIsLocal : workspaceOrIsLocal === "local";
  return isLocalWorkspace && shouldPersistWorkspaceProject(options);
}

export function shouldSnapshotProjectConnectionForRestart({
  status,
  workspace,
  directory,
}: {
  status: ConnectionStatus;
  workspace: Workspace;
  directory: string;
}) {
  return status.kind !== "chat-infra" && workspace.projects.includes(directory);
}
