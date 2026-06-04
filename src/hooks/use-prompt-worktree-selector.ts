import * as React from "react";
import type { Session } from "@/hooks/agent-state-types";
import { useOpenGuiClient } from "@/protocol/provider";
import {
  compareWorktreesByLabel,
  getWorktreeLabel,
  getWorkspaceRootProjectDirectory,
  isRootWorktreePath,
} from "@/lib/worktree-placement";
import { normalizeProjectPath } from "@/lib/utils";
import type { GitWorktree } from "@/types/electron";
import type { WorktreeParentMap } from "@/hooks/agent-state-persistence";

export function buildPromptWorktreeOptions({
  discoveryState,
  projectDir,
  discoveredWorktrees,
}: {
  discoveryState: "hidden" | "ready" | "error";
  projectDir: string | null;
  discoveredWorktrees: GitWorktree[];
}) {
  if (discoveryState !== "ready" || !projectDir) return [];
  const byPath = new Map<string, GitWorktree>();
  for (const worktree of discoveredWorktrees) {
    const normalizedPath = normalizeProjectPath(worktree.path);
    if (!normalizedPath) continue;
    byPath.set(normalizedPath, { ...worktree, path: normalizedPath });
  }
  return Array.from(byPath.values())
    .sort((left, right) => {
      const leftIsRoot = isRootWorktreePath(left.path, projectDir);
      const rightIsRoot = isRootWorktreePath(right.path, projectDir);
      if (leftIsRoot !== rightIsRoot) return leftIsRoot ? -1 : 1;
      return compareWorktreesByLabel(left, right, projectDir);
    })
    .map((worktree) => ({
      ...worktree,
      isRoot: isRootWorktreePath(worktree.path, projectDir),
      label: getWorktreeLabel({ ...worktree, rootDirectory: projectDir }),
    }));
}

export function usePromptWorktreeSelector({
  activeSession,
  activeSessionId,
  activeTargetDirectory,
  worktreeParents,
  isLocalWorkspace,
  registerWorktree,
}: {
  activeSession: Session | null;
  activeSessionId: string | null;
  activeTargetDirectory: string | null;
  worktreeParents: WorktreeParentMap;
  isLocalWorkspace: boolean;
  registerWorktree: (worktreeDir: string, parentDir: string, branch: string) => void;
}) {
  const client = useOpenGuiClient();
  const [discoveredWorktrees, setDiscoveredWorktrees] = React.useState<GitWorktree[]>([]);
  const [discoveryState, setDiscoveryState] = React.useState<"hidden" | "ready" | "error">(
    "hidden",
  );
  const worktreeParentsRef = React.useRef(worktreeParents);
  const registerWorktreeRef = React.useRef(registerWorktree);

  React.useEffect(() => {
    worktreeParentsRef.current = worktreeParents;
  }, [worktreeParents]);

  React.useEffect(() => {
    registerWorktreeRef.current = registerWorktree;
  }, [registerWorktree]);

  const selectedDirectory = React.useMemo(
    () =>
      normalizeProjectPath(
        activeSession?._projectDir ?? activeSession?.directory ?? activeTargetDirectory ?? "",
      ) || null,
    [activeSession, activeTargetDirectory],
  );

  const projectDir = React.useMemo(() => {
    if (!selectedDirectory) return null;
    return getWorkspaceRootProjectDirectory(selectedDirectory, worktreeParents);
  }, [selectedDirectory, worktreeParents]);

  React.useEffect(() => {
    if (!projectDir || !isLocalWorkspace) {
      setDiscoveredWorktrees([]);
      setDiscoveryState("hidden");
      return;
    }

    let cancelled = false;
    void Promise.all([client.git.isRepo(projectDir), client.git.listWorktrees(projectDir)])
      .then(([isRepo, worktrees]) => {
        if (cancelled) return;
        if (!isRepo) {
          setDiscoveredWorktrees([]);
          setDiscoveryState("hidden");
          return;
        }
        const normalizedWorktrees = worktrees.map((worktree) => ({
          ...worktree,
          path: normalizeProjectPath(worktree.path),
        }));
        for (const worktree of normalizedWorktrees) {
          if (worktree.path === projectDir || worktreeParentsRef.current[worktree.path]) continue;
          registerWorktreeRef.current(worktree.path, projectDir, worktree.branch ?? "unknown");
        }
        setDiscoveredWorktrees(normalizedWorktrees);
        setDiscoveryState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setDiscoveredWorktrees([]);
        setDiscoveryState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [client, projectDir, isLocalWorkspace]);

  const options = React.useMemo(
    () =>
      buildPromptWorktreeOptions({
        discoveryState,
        projectDir,
        discoveredWorktrees,
      }),
    [discoveredWorktrees, projectDir, discoveryState],
  );

  const selectedOption = React.useMemo(
    () => options.find((option) => option.path === selectedDirectory) ?? null,
    [options, selectedDirectory],
  );

  return {
    selectedDirectory,
    projectDir,
    options,
    selectedOption,
    shouldShowSelector:
      Boolean(projectDir) && isLocalWorkspace && discoveryState === "ready" && options.length > 1,
    isPendingTargetSelection: !activeSessionId && Boolean(activeTargetDirectory),
  };
}
