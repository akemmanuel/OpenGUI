import { getProjectName, normalizeProjectPath } from "@/lib/utils";

export interface WorktreeLike {
  path: string;
  branch?: string | null;
  detached?: boolean;
}

export interface WorktreePlacementParentLike {
  parentDir: string;
  branch?: string | null;
}

export interface WorktreePlacementSessionLike {
  directory: string;
  _projectDir?: string | null;
}

export type WorktreePlacementMap = Record<string, WorktreePlacementParentLike | undefined>;

export interface WorktreePlacementInfo {
  executionDirectory: string;
  rootDirectory: string;
  displayDirectory: string;
  isKnownWorktree: boolean;
  branchLabel: string | null;
}

export function isRootWorktreePath(
  path: string | null | undefined,
  rootDirectory: string | null | undefined,
): boolean {
  const normalizedPath = normalizeOptionalDirectory(path);
  const normalizedRootDirectory = normalizeOptionalDirectory(rootDirectory);
  return Boolean(
    normalizedPath && normalizedRootDirectory && normalizedPath === normalizedRootDirectory,
  );
}

export function getWorktreeLabel({
  path,
  branch,
  detached,
  rootDirectory,
}: WorktreeLike & { rootDirectory?: string | null }): string {
  const normalizedPath = normalizeOptionalDirectory(path);
  const isRoot = isRootWorktreePath(normalizedPath, rootDirectory);
  const fallbackName = getProjectName(normalizedPath, "worktree");
  const trimmedBranch = branch?.trim();

  if (detached) {
    return `${fallbackName} (${isRoot ? "detached HEAD, root" : "detached HEAD"})`;
  }

  const label = trimmedBranch && trimmedBranch !== "unknown" ? trimmedBranch : fallbackName;
  return isRoot ? `${label} (root)` : label;
}

export function compareWorktreesByLabel(
  a: WorktreeLike,
  b: WorktreeLike,
  rootDirectory: string | null | undefined,
): number {
  return getWorktreeLabel({ ...a, rootDirectory }).localeCompare(
    getWorktreeLabel({ ...b, rootDirectory }),
    undefined,
    { sensitivity: "base" },
  );
}

function normalizeOptionalDirectory(directory?: string | null): string {
  return normalizeProjectPath(directory ?? "");
}

export function getWorktreePlacementMeta(
  directory: string | null | undefined,
  worktreeParents: WorktreePlacementMap,
): WorktreePlacementParentLike | null {
  const normalizedDirectory = normalizeOptionalDirectory(directory);
  if (!normalizedDirectory) return null;
  return worktreeParents[normalizedDirectory] ?? null;
}

export function isKnownWorktreeDirectory(
  directory: string | null | undefined,
  worktreeParents: WorktreePlacementMap,
): boolean {
  return getWorktreePlacementMeta(directory, worktreeParents) !== null;
}

export function shouldHideTopLevelProjectDirectory(
  directory: string | null | undefined,
  worktreeParents: WorktreePlacementMap,
): boolean {
  return isKnownWorktreeDirectory(directory, worktreeParents);
}

export function getWorkspaceRootProjectDirectory(
  directory: string | null | undefined,
  worktreeParents: WorktreePlacementMap,
): string {
  const normalizedDirectory = normalizeOptionalDirectory(directory);
  if (!normalizedDirectory) return "";
  return normalizeOptionalDirectory(
    getWorktreePlacementMeta(normalizedDirectory, worktreeParents)?.parentDir ??
      normalizedDirectory,
  );
}

export function getSessionExecutionDirectory(
  session: WorktreePlacementSessionLike | null | undefined,
): string {
  if (!session) return "";
  return normalizeOptionalDirectory(session._projectDir ?? session.directory);
}

export function getWorktreeDisplayLabel(
  directory: string | null | undefined,
  worktreeParents: WorktreePlacementMap,
): string | null {
  const normalizedDirectory = normalizeOptionalDirectory(directory);
  if (!normalizedDirectory) return null;
  const rootDirectory = getWorkspaceRootProjectDirectory(normalizedDirectory, worktreeParents);
  const branch = getWorktreePlacementMeta(normalizedDirectory, worktreeParents)?.branch?.trim();
  return getWorktreeLabel({
    path: normalizedDirectory,
    branch,
    rootDirectory,
  });
}

export function getDirectoryPlacementInfo(
  directory: string | null | undefined,
  worktreeParents: WorktreePlacementMap,
  assignedProjectDir?: string | null,
): WorktreePlacementInfo | null {
  const executionDirectory = normalizeOptionalDirectory(directory);
  if (!executionDirectory) return null;
  const rootDirectory = getWorkspaceRootProjectDirectory(executionDirectory, worktreeParents);
  const displayDirectory = normalizeOptionalDirectory(assignedProjectDir) || rootDirectory;
  return {
    executionDirectory,
    rootDirectory,
    displayDirectory,
    isKnownWorktree: rootDirectory !== executionDirectory,
    branchLabel: getWorktreeDisplayLabel(executionDirectory, worktreeParents),
  };
}

export function getSessionPlacementInfo(
  session: WorktreePlacementSessionLike | null | undefined,
  worktreeParents: WorktreePlacementMap,
  assignedProjectDir?: string | null,
): WorktreePlacementInfo | null {
  return getDirectoryPlacementInfo(
    getSessionExecutionDirectory(session),
    worktreeParents,
    assignedProjectDir,
  );
}

export function shouldShowSessionInProjectList(
  session: WorktreePlacementSessionLike | null | undefined,
  {
    worktreeParents,
    visibleProjectDirectories,
    assignedProjectDir,
  }: {
    worktreeParents: WorktreePlacementMap;
    visibleProjectDirectories: Iterable<string>;
    assignedProjectDir?: string | null;
  },
): boolean {
  const placement = getSessionPlacementInfo(session, worktreeParents, assignedProjectDir);
  if (!placement) return false;
  const visibleDirectorySet = new Set(
    Array.from(visibleProjectDirectories)
      .map((directory) => normalizeOptionalDirectory(directory))
      .filter(Boolean),
  );
  return (
    visibleDirectorySet.has(placement.displayDirectory) ||
    visibleDirectorySet.has(placement.executionDirectory)
  );
}

export function listRelatedWorktreeDirectories(
  rootDirectory: string,
  worktreeParents: WorktreePlacementMap,
): string[] {
  const normalizedRootDirectory = normalizeOptionalDirectory(rootDirectory);
  if (!normalizedRootDirectory) return [];
  return Object.entries(worktreeParents)
    .filter(([, meta]) => normalizeOptionalDirectory(meta?.parentDir) === normalizedRootDirectory)
    .map(([directory]) => normalizeOptionalDirectory(directory))
    .filter(Boolean);
}
