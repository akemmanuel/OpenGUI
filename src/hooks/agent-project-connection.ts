import {
  createLocalWorkspace,
  getWorkspaceRootDirectory,
  LOCAL_WORKSPACE_ID,
  type WorktreeParentMap,
} from "@/hooks/agent-state-persistence";
import { makeProjectKey } from "@/hooks/agent-session-utils";
import type { ConnectionStatus, Workspace } from "@/types/electron";
import { DEFAULT_SERVER_URL } from "@/lib/constants";
import { normalizeProjectPath } from "@/lib/utils";

interface ProjectConfig {
  workspaceId: string;
  baseUrl: string;
  directory: string;
  username?: string;
  password?: string;
}

function uniqueOrdered(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function createProjectConnectionStatus(
  state: ConnectionStatus["state"],
  serverUrl: string,
): ConnectionStatus {
  return {
    state,
    serverUrl,
    serverVersion: null,
    error: null,
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
  const rootDirectory = getWorkspaceRootDirectory(normalizedDirectory, worktreeParents);
  const relatedWorktrees = Object.entries(worktreeParents)
    .filter(([, meta]) => meta.parentDir === rootDirectory)
    .map(([worktreeDir]) => worktreeDir);
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
  const workspaceDirectory = getWorkspaceRootDirectory(directory, worktreeParents);
  const directoriesToRemove =
    workspaceDirectory === directory
      ? [
          workspaceDirectory,
          ...Object.entries(worktreeParents)
            .filter(([, meta]) => meta.parentDir === workspaceDirectory)
            .map(([worktreeDir]) => worktreeDir),
        ]
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
    workspace.id === LOCAL_WORKSPACE_ID && detachedProject
      ? { ...workspace, projects: [detachedProject] }
      : workspace,
  );
  const projectConfigs: ProjectConfig[] = [];
  const expectedProjectKeys: string[] = [];
  const seenProjectKeys = new Set<string>();

  for (const workspace of bootWorkspaces) {
    for (const project of workspace.projects) {
      const plan = createWorkspaceProjectConnectionPlan({
        directory: project,
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
        });
      }
    }
  }

  return { projectConfigs, expectedProjectKeys };
}

export function createWorkspaceConnectionConfig({
  workspace,
  directory,
}: {
  workspace: Workspace;
  directory: string;
}) {
  return {
    workspaceId: workspace.id,
    baseUrl: workspace.serverUrl ?? DEFAULT_SERVER_URL,
    directory,
    username: workspace.username,
    password: workspace.password,
  };
}

export function shouldPersistWorkspaceProject(options?: { hidden?: boolean; transient?: boolean }) {
  return !options?.hidden && !options?.transient;
}

export function shouldPersistLocalConnectionSettings(
  workspaceId: string,
  options?: { hidden?: boolean; transient?: boolean },
) {
  return workspaceId === LOCAL_WORKSPACE_ID && shouldPersistWorkspaceProject(options);
}
