import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { useActions, useConnectionState } from "@/hooks/use-agent-state";
import type { useOpenGuiClient } from "@/protocol/provider";
import { POST_MERGE_DELAY_MS } from "@/lib/constants";
import { getDirectoryPlacementInfo, getWorktreePlacementMeta } from "@/lib/worktree-placement";
import { buildPRUrl, openExternalLink } from "@/lib/utils";

type ConnectionState = ReturnType<typeof useConnectionState>;
type Actions = ReturnType<typeof useActions>;
type OpenGuiClient = ReturnType<typeof useOpenGuiClient>;

export interface WorktreeMergeInfo {
  mainDir: string;
  branch: string;
  worktreePath: string;
}

interface UseActiveWorktreeMergeParams {
  activeSessionDirectory: string | null;
  worktreeParents: ConnectionState["worktreeParents"];
  client: OpenGuiClient;
  sendPrompt: Actions["sendPrompt"];
  setActiveTarget: Actions["setActiveTarget"];
  removeProject: Actions["removeProject"];
  unregisterWorktree: Actions["unregisterWorktree"];
}

export function useActiveWorktreeMerge({
  activeSessionDirectory,
  worktreeParents,
  client,
  sendPrompt,
  setActiveTarget,
  removeProject,
  unregisterWorktree,
}: UseActiveWorktreeMergeParams) {
  const [mergeInfo, setMergeInfo] = useState<WorktreeMergeInfo | null>(null);
  const [activeWorktreeRemoteUrl, setActiveWorktreeRemoteUrl] = useState<string | null>(null);
  const fixWithAiTimeoutRef = useRef<number | null>(null);

  const activeWorktreeInfo = useMemo<WorktreeMergeInfo | null>(() => {
    const placement = getDirectoryPlacementInfo(activeSessionDirectory, worktreeParents);
    if (!placement?.isKnownWorktree) return null;
    return {
      mainDir: placement.rootDirectory,
      branch:
        getWorktreePlacementMeta(activeSessionDirectory, worktreeParents)?.branch ?? "unknown",
      worktreePath: placement.executionDirectory,
    };
  }, [activeSessionDirectory, worktreeParents]);

  useEffect(() => {
    return () => {
      if (fixWithAiTimeoutRef.current !== null) {
        window.clearTimeout(fixWithAiTimeoutRef.current);
        fixWithAiTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const mainDir = activeWorktreeInfo?.mainDir;
    if (!mainDir) {
      setActiveWorktreeRemoteUrl(null);
      return;
    }
    void client.git
      .getRemoteUrl(mainDir)
      .then((remoteUrl) => {
        if (!cancelled) setActiveWorktreeRemoteUrl(remoteUrl || null);
      })
      .catch(() => {
        if (!cancelled) setActiveWorktreeRemoteUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorktreeInfo?.mainDir, client]);

  const openPullRequest = useCallback(() => {
    if (!activeWorktreeRemoteUrl || !activeWorktreeInfo) return;
    const url = buildPRUrl(activeWorktreeRemoteUrl, activeWorktreeInfo.branch);
    if (url) openExternalLink(url);
  }, [activeWorktreeInfo, activeWorktreeRemoteUrl]);

  const handleMerged = useCallback(
    async (deleteWorktree: boolean) => {
      if (!mergeInfo) return;
      if (deleteWorktree) {
        unregisterWorktree(mergeInfo.worktreePath);
        await removeProject(mergeInfo.worktreePath);
        await client.git.removeWorktree(mergeInfo.mainDir, mergeInfo.worktreePath);
      }
      if (activeWorktreeInfo?.mainDir === mergeInfo.mainDir) {
        try {
          const remoteUrl = await client.git.getRemoteUrl(mergeInfo.mainDir);
          setActiveWorktreeRemoteUrl(remoteUrl || null);
        } catch {
          setActiveWorktreeRemoteUrl(null);
        }
      }
    },
    [activeWorktreeInfo?.mainDir, client, mergeInfo, removeProject, unregisterWorktree],
  );

  const handleFixWithAI = useCallback(
    (conflicts: string[]) => {
      if (!mergeInfo) return;

      setActiveTarget(mergeInfo.mainDir);
      if (fixWithAiTimeoutRef.current !== null) {
        window.clearTimeout(fixWithAiTimeoutRef.current);
      }
      fixWithAiTimeoutRef.current = window.setTimeout(() => {
        const fileList = conflicts.map((file) => `- ${file}`).join("\n");
        void sendPrompt(
          `There are git merge conflicts from merging branch "${mergeInfo.branch}" into the current branch.\n\nThe following files have unresolved conflicts:\n${fileList}\n\nPlease resolve all merge conflicts in these files. Remove all conflict markers (<<<<<<, ======, >>>>>>) and produce the correct merged code. After resolving all conflicts, stage the resolved files with \`git add\` for each file.`,
        );
        fixWithAiTimeoutRef.current = null;
      }, POST_MERGE_DELAY_MS);
    },
    [mergeInfo, sendPrompt, setActiveTarget],
  );

  return {
    activeWorktreeInfo,
    activeWorktreeRemoteUrl,
    mergeInfo,
    setMergeInfo,
    openPullRequest,
    handleMerged,
    handleFixWithAI,
  };
}
