import { normalizeProjectPath } from "@/lib/utils";

/** Workspace Projects that should appear in the sidebar (not hidden by project meta). */
export function listSidebarAvailableProjectDirectories(
  workspaceProjects: string[] | undefined,
  isHidden: (directory: string) => boolean,
): string[] {
  return (workspaceProjects ?? []).filter((directory) => !isHidden(directory));
}

/**
 * Root project directories to render in the Projects section.
 * Must include every workspace project even when Harness connection is still pending.
 */
export function buildSidebarOrderedRootProjectDirectories(input: {
  availableProjectDirectories: string[];
  connectedRootDirectories: string[];
  detachedProject?: string | null;
}): string[] {
  const normalizedDetached = normalizeProjectPath(input.detachedProject ?? "");
  if (normalizedDetached) {
    return input.connectedRootDirectories.filter((dir) => dir === normalizedDetached);
  }

  const available = input.availableProjectDirectories
    .map((dir) => normalizeProjectPath(dir))
    .filter((dir): dir is string => Boolean(dir));
  const connectedSet = new Set(
    input.connectedRootDirectories.map((dir) => normalizeProjectPath(dir)).filter(Boolean),
  );

  const connectedFirst = available.filter((dir) => connectedSet.has(dir));
  const pending = available.filter((dir) => !connectedSet.has(dir));
  return [...connectedFirst, ...pending];
}

export function isProjectListedInSidebar(
  directory: string,
  orderedRootDirectories: string[],
): boolean {
  const normalized = normalizeProjectPath(directory);
  return Boolean(normalized && orderedRootDirectories.includes(normalized));
}
