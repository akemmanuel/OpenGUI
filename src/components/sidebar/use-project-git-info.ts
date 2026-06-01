import { useCallback, useEffect, useState } from "react";
import type { WorktreeParentMap } from "@/hooks/agent-state-persistence";
import type { OpenGuiClient } from "@/protocol/client";
import { normalizeProjectPath, pruneRecord } from "@/lib/utils";
import type { GitWorktree } from "@/types/electron";

export function useProjectGitInfo({
  client,
  openDirectories,
  worktreeParents,
  registerWorktree,
  unregisterWorktree,
}: {
  client: OpenGuiClient;
  openDirectories: string[];
  worktreeParents: WorktreeParentMap;
  registerWorktree: (worktreeDir: string, parentDir: string, branch: string) => void;
  unregisterWorktree: (worktreeDir: string) => void;
}) {
  const [isGitRepo, setIsGitRepo] = useState<Record<string, boolean>>({});
  const [knownWorktrees, setKnownWorktrees] = useState<Record<string, GitWorktree[]>>({});
  const [remoteUrls, setRemoteUrls] = useState<Record<string, string>>({});

  const refreshGitInfo = useCallback(
    async (directory: string) => {
      const normalizedDirectory = normalizeProjectPath(directory);
      const isRepo = await client.git.isRepo(normalizedDirectory).catch(() => false);
      setIsGitRepo((prev) => ({ ...prev, [normalizedDirectory]: isRepo }));
      if (!isRepo) return;

      const [actualWorktrees, remoteUrl] = await Promise.all([
        client.git.listWorktrees(normalizedDirectory).catch(() => null),
        client.git.getRemoteUrl(normalizedDirectory).catch(() => null),
      ]);

      if (actualWorktrees) {
        const normalizedWorktrees = actualWorktrees.map((wt) => ({
          ...wt,
          path: normalizeProjectPath(wt.path),
        }));
        setKnownWorktrees((prev) => ({
          ...prev,
          [normalizedDirectory]: normalizedWorktrees,
        }));
        const actualPaths = new Set(normalizedWorktrees.map((wt) => wt.path));
        for (const wt of normalizedWorktrees) {
          if (wt.path === normalizedDirectory) continue;
          if (!worktreeParents[wt.path]) {
            registerWorktree(wt.path, normalizedDirectory, wt.branch ?? "unknown");
          }
        }
        for (const [wtDir, info] of Object.entries(worktreeParents)) {
          if (info.parentDir === normalizedDirectory && !actualPaths.has(wtDir)) {
            unregisterWorktree(wtDir);
          }
        }
      }

      if (remoteUrl) {
        setRemoteUrls((prev) => ({ ...prev, [normalizedDirectory]: remoteUrl }));
      }
    },
    [client, registerWorktree, worktreeParents, unregisterWorktree],
  );

  useEffect(() => {
    const validDirs = new Set(openDirectories);
    setIsGitRepo((prev) => pruneRecord(prev, validDirs));
    setKnownWorktrees((prev) => pruneRecord(prev, validDirs));
    setRemoteUrls((prev) => pruneRecord(prev, validDirs));
  }, [openDirectories]);

  return { isGitRepo, knownWorktrees, remoteUrls, refreshGitInfo };
}
