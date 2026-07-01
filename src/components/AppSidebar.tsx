import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sidebar, SidebarContent, useSidebar } from "@/components/ui/sidebar";
import { getSessionExecutionDirectory } from "@/hooks/agent-session-utils";
import { useHomeDir } from "@/hooks/use-home-dir";
import { useCurrentHarnessId } from "@/hooks/use-agent-backend";
import { useActions, useConnectionState, useSessionState } from "@/hooks/use-agent-state";
import { useOpenGuiClient } from "@/protocol/provider";
import { useOutsideClick } from "@/hooks/use-outside-click";
import { POST_MERGE_DELAY_MS, SESSION_PAGE_SIZE } from "@/lib/constants";
import { openAddWorkspaceDialog } from "@/hooks/workspace-guards";
import { notifyInfo } from "@/lib/notify";
import { normalizeProjectPath } from "@/lib/utils";
import { MergeDialog } from "./MergeDialog";
import { ProjectPathDialog } from "./ProjectPathDialog";
import { WorktreeDialog } from "./WorktreeDialog";
import { WorktreeSetupDialog } from "./WorktreeSetupDialog";
import { CollapsedProjectPopover } from "./sidebar/CollapsedProjectPopover";
import { SidebarContentSections } from "./sidebar/SidebarContentSections";
import { SidebarFooterContent } from "./sidebar/SidebarFooterContent";
import { SidebarHeaderContent } from "./sidebar/SidebarHeaderContent";
import { useSidebarCollapsedProjects } from "./sidebar/use-sidebar-collapsed-projects";
import { useProjectGitInfo } from "./sidebar/use-project-git-info";
import { useSidebarRename } from "./sidebar/use-sidebar-rename";
import { useSidebarRenderers } from "./sidebar/use-sidebar-renderers";
import { useSidebarModel } from "./sidebar/use-sidebar-model";

export function AppSidebar({
  detachedProject,
  highlightedSessionId,
  onOpenSettings,
  onOpenChat,
  settingsActive = false,
}: {
  detachedProject?: string;
  highlightedSessionId?: string | null;
  onOpenSettings: () => void;
  onOpenChat: () => void;
  settingsActive?: boolean;
}) {
  const client = useOpenGuiClient();
  const preferredHarnessId = useCurrentHarnessId();
  const { t } = useTranslation();
  const { state: sidebarState, isMobile, setOpen: setSidebarOpen, setOpenMobile } = useSidebar();
  const {
    selectSession,
    startNewChat,
    setActiveTarget,
    deleteSession,
    renameSession,
    removeProject,
    openDirectory,
    connectToProject,
    setSessionColor,
    setSessionTags,
    setSessionPinned,
    moveSessionToProject,
    removeSessionFromProject,
    setProjectPinned,
    registerWorktree,
    unregisterWorktree,
    sendPrompt,
    reorderVisibleProjects,
  } = useActions();
  const {
    sessions,
    activeSessionId,
    busySessionIds,
    queuedPrompts,
    pendingQuestions,
    pendingPermissions,
    unreadSessionIds,
    sessionDrafts,
    sessionMeta,
    namingSessionIds,
    activeTargetDirectory,
  } = useSessionState();

  const visibleActiveSessionId =
    highlightedSessionId === undefined ? activeSessionId : highlightedSessionId;
  const {
    connections,
    worktreeParents,
    projectMeta,
    isLocalWorkspace,
    supportsNativeDirectoryPicker,
    activeWorkspace,
    workspaces,
    canManageProjects,
    workspaceDirectory,
    defaultChatDirectory,
    bootState,
    projectHydration,
  } = useConnectionState();

  // Inline rename state
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const {
    editingSessionId,
    editValue,
    setEditValue,
    editInputRef,
    startEditing,
    commitRename,
    cancelEditing,
  } = useSidebarRename({ sessions, renameSession });

  const homeDir = useHomeDir();
  const requestProjectPath = useCallback(
    (initialPath?: string) =>
      new Promise<string | null>((resolve) => {
        window.dispatchEvent(
          new CustomEvent("opengui:open-project-path-dialog", {
            detail: { resolve, initialPath },
          }),
        );
      }),
    [],
  );
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSessionDirectory =
    getSessionExecutionDirectory(activeSession) || activeTargetDirectory || null;

  const {
    hasActiveSearch,
    availableProjectDirectories,
    filteredChatSessions,
    pinnedEntries,
    projectEntries: filteredProjectEntries,
    projectSessionsByDirectory,
    showChatsSection,
  } = useSidebarModel({
    sessions,
    sessionMeta,
    projectMeta,
    worktreeParents,
    activeWorkspace,
    connections,
    detachedProject,
    defaultChatDirectory,
    preferredHarnessId,
    searchQuery,
    untitledLabel: t("sidebar.untitled"),
  });

  // Set of directories that are worktrees (should be hidden from project list)
  const worktreeDirs = useMemo(() => new Set(Object.keys(worktreeParents)), [worktreeParents]);

  // Worktree dialog state
  const [worktreeDialogDir, setWorktreeDialogDir] = useState<string | null>(null);
  // Post-creation setup dialog state
  const [setupWorktreePath, setSetupWorktreePath] = useState<string | null>(null);
  // Merge dialog state
  const [mergeInfo, setMergeInfo] = useState<{
    mainDir: string;
    branch: string;
    worktreePath: string;
  } | null>(null);
  const fixWithAiTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (fixWithAiTimeoutRef.current !== null) {
        window.clearTimeout(fixWithAiTimeoutRef.current);
        fixWithAiTimeoutRef.current = null;
      }
    };
  }, []);

  const openDirectories = useMemo(() => Object.keys(connections), [connections]);
  const { isGitRepo, knownWorktrees, remoteUrls, refreshGitInfo } = useProjectGitInfo({
    client,
    openDirectories,
    worktreeParents,
    registerWorktree,
    unregisterWorktree,
  });
  const activeWorkspaceProjectDirectories = useMemo(
    () => activeWorkspace?.projects ?? [],
    [activeWorkspace?.projects],
  );
  const { collapsed, toggleCollapsed, revealCollapsedProject } = useSidebarCollapsedProjects({
    activeWorkspaceProjectDirectories,
    detachedProject,
    hydrationReady: bootState === "ready",
    openDirectories,
  });
  const [visibleByProject, setVisibleByProject] = useState<Record<string, number>>({});
  const [visibleChatCount, setVisibleChatCount] = useState(SESSION_PAGE_SIZE);
  const [projectPopover, setProjectPopover] = useState<{
    directory: string;
    top: number;
  } | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (sidebarState !== "collapsed") {
      setProjectPopover(null);
    }
  }, [sidebarState]);

  const closeProjectPopover = useCallback(() => setProjectPopover(null), []);
  useOutsideClick(popoverRef, closeProjectPopover, !!projectPopover);

  const popoverSessions = projectPopover
    ? (projectSessionsByDirectory[projectPopover.directory] ?? [])
    : [];
  const visibleChatSessions = filteredChatSessions.slice(0, visibleChatCount);
  const hasMoreChats = filteredChatSessions.length > visibleChatCount;
  const canShowLessChats = visibleChatCount > SESSION_PAGE_SIZE;
  const projectLabel = t("sidebar.projects");
  const closeOtherProjects = useCallback(
    async (directory: string) => {
      const normalizedDirectory = normalizeProjectPath(directory);
      if (!normalizedDirectory || detachedProject) return;
      const otherDirectories = availableProjectDirectories.filter(
        (projectDirectory) => normalizeProjectPath(projectDirectory) !== normalizedDirectory,
      );
      await Promise.all(
        otherDirectories.map((projectDirectory) => removeProject(projectDirectory)),
      );
    },
    [availableProjectDirectories, detachedProject, removeProject],
  );

  useEffect(() => {
    const focusSidebarSearch = () => {
      if (isMobile) {
        setOpenMobile(true);
      } else {
        setSidebarOpen(true);
      }
      requestAnimationFrame(() => {
        searchInputRef.current?.focus({ preventScroll: true });
        searchInputRef.current?.select();
      });
    };

    window.addEventListener("focus-sidebar-search", focusSidebarSearch);
    return () => {
      window.removeEventListener("focus-sidebar-search", focusSidebarSearch);
    };
  }, [isMobile, setOpenMobile, setSidebarOpen]);

  const handleAddProject = useCallback(async () => {
    if (!canManageProjects) {
      notifyInfo(t("workspace.requiredBeforeProject"));
      if (workspaces.length === 0) openAddWorkspaceDialog();
      return;
    }
    const dir = supportsNativeDirectoryPicker
      ? await openDirectory()
      : await requestProjectPath(workspaceDirectory ?? undefined);
    if (dir) void connectToProject(dir);
  }, [
    canManageProjects,
    connectToProject,
    supportsNativeDirectoryPicker,
    openDirectory,
    requestProjectPath,
    t,
    workspaceDirectory,
    workspaces.length,
  ]);

  const hasUnsentDraft = useCallback(
    (sessionId: string) => Boolean(sessionDrafts[`session:${sessionId}`]?.trim()),
    [sessionDrafts],
  );

  const revealSessionInProject = useCallback(
    (directory: string) => {
      const normalizedDirectory = normalizeProjectPath(directory);
      if (!normalizedDirectory) return;
      revealCollapsedProject(normalizedDirectory);
    },
    [revealCollapsedProject],
  );

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const { renderSessionRow, renderProjectEntry } = useSidebarRenderers({
    activeSessionId: visibleActiveSessionId,
    availableProjectDirectories,
    busySessionIds,
    cancelEditing,
    client,
    closeMobileSidebar,
    closeOtherProjects,
    collapsed,
    commitRename,
    connections,
    deleteSession,
    detachedProject,
    editInputRef,
    editValue,
    editingSessionId,
    hasActiveSearch,
    hasUnsentDraft,
    homeDir,
    isGitRepo,
    isLocalWorkspace,
    knownWorktrees,
    moveSessionToProject,
    namingSessionIds,
    pendingPermissions,
    pendingQuestions,
    projectMeta,
    projectHydration,
    queuedPrompts,
    refreshGitInfo,
    remoteUrls,
    removeProject,
    removeSessionFromProject,
    revealSessionInProject,
    selectSession,
    sessionMeta,
    setActiveTarget,
    setEditValue,
    setMergeInfo,
    setProjectPinned,
    setProjectPopover,
    setSessionColor,
    setSessionPinned,
    setSessionTags,
    setVisibleByProject,
    setWorktreeDialogDir,
    sidebarState,
    startEditing,
    t,
    toggleCollapsed,
    unreadSessionIds,
    unregisterWorktree,
    visibleByProject,
    worktreeDirs,
    worktreeParents,
    workspaceId: activeWorkspace?.id,
  });

  return (
    <Sidebar collapsible="icon" className="select-none relative">
      <SidebarHeaderContent
        searchInputRef={searchInputRef}
        searchQuery={searchQuery}
        hasActiveSearch={hasActiveSearch}
        detachedProject={detachedProject}
        showChatsSection={showChatsSection}
        labels={{
          searchPlaceholder: t("sidebar.searchPlaceholder"),
          clearSearch: t("sidebar.clearSearch"),
          newChat: t("sidebar.newChat"),
        }}
        setSearchQuery={setSearchQuery}
        onOpenChat={onOpenChat}
        startNewChat={startNewChat}
        closeMobileSidebar={closeMobileSidebar}
      />

      <SidebarContent className="overflow-x-hidden" onClickCapture={onOpenChat}>
        <SidebarContentSections
          pinnedEntries={pinnedEntries}
          filteredChatSessions={filteredChatSessions}
          visibleChatSessions={visibleChatSessions}
          filteredProjectEntries={filteredProjectEntries}
          hasActiveSearch={hasActiveSearch}
          detachedProject={detachedProject}
          showChatsSection={showChatsSection}
          visibleChatCount={visibleChatCount}
          hasMoreChats={hasMoreChats}
          canShowLessChats={canShowLessChats}
          worktreeParents={worktreeParents}
          sessionMeta={sessionMeta}
          labels={{
            pinned: t("sidebar.pinned"),
            chats: t("sidebar.chats"),
            projects: projectLabel,
            newChat: t("sidebar.newChat"),
            addProject: t("sidebar.addProject"),
            noMatches: t("sidebar.noMatches", { query: searchQuery.trim() }),
            noChats: t("sidebar.noChats"),
            loadMore: (count) => t("sidebar.loadMore", { count }),
            showLess: t("sidebar.showLess"),
            allProjectsPinned: t("sidebar.allProjectsPinned"),
            noProjectsYet: t("sidebar.noProjectsYet"),
            needWorkspaceBeforeProjects: t("sidebar.needWorkspaceBeforeProjects"),
            addWorkspace: t("workspace.addWorkspace"),
          }}
          canManageProjects={canManageProjects}
          onAddWorkspace={openAddWorkspaceDialog}
          renderProjectEntry={renderProjectEntry}
          renderSessionRow={renderSessionRow}
          startNewChat={startNewChat}
          closeMobileSidebar={closeMobileSidebar}
          setVisibleChatCount={setVisibleChatCount}
          handleAddProject={handleAddProject}
          reorderVisibleProjects={reorderVisibleProjects}
        />

        {projectPopover && sidebarState === "collapsed" && (
          <CollapsedProjectPopover
            popoverRef={popoverRef}
            directory={projectPopover.directory}
            top={projectPopover.top}
            sessions={popoverSessions}
            activeSessionId={visibleActiveSessionId}
            busySessionIds={busySessionIds}
            unreadSessionIds={unreadSessionIds}
            queuedPrompts={queuedPrompts}
            pendingQuestions={pendingQuestions}
            pendingPermissions={pendingPermissions}
            namingSessionIds={namingSessionIds}
            untitledLabel={t("sidebar.untitled")}
            labels={{
              newSession: t("sidebar.newSession"),
              noSessionsYet: t("sidebar.noSessionsYet"),
            }}
            hasUnsentDraft={hasUnsentDraft}
            setActiveTarget={setActiveTarget}
            selectSession={selectSession}
            closePopover={closeProjectPopover}
            closeMobileSidebar={closeMobileSidebar}
          />
        )}
      </SidebarContent>

      {!detachedProject && (
        <SidebarFooterContent
          activeSessionDirectory={activeSessionDirectory}
          homeDir={homeDir}
          settingsActive={settingsActive}
          onOpenSettings={() => {
            onOpenSettings();
            closeMobileSidebar();
          }}
        />
      )}

      <ProjectPathDialog />

      {/* Worktree creation dialog */}
      <WorktreeDialog
        open={worktreeDialogDir !== null}
        onOpenChange={(open) => {
          if (!open) setWorktreeDialogDir(null);
        }}
        directory={worktreeDialogDir ?? ""}
        onCreated={async (worktreePath, branch) => {
          if (!worktreeDialogDir) return;
          // Register in local state with metadata
          registerWorktree(worktreePath, worktreeDialogDir, branch);
          // Connect to the worktree directory
          await connectToProject(worktreePath);
          // Refresh git info
          void refreshGitInfo(worktreeDialogDir);
          // Trigger setup detection dialog
          setSetupWorktreePath(worktreePath);
        }}
      />

      {/* Merge dialog */}
      <MergeDialog
        open={mergeInfo !== null}
        onOpenChange={(open) => {
          if (!open) setMergeInfo(null);
        }}
        mainDirectory={mergeInfo?.mainDir ?? ""}
        branch={mergeInfo?.branch ?? ""}
        onMerged={async (deleteWt) => {
          if (!mergeInfo) return;
          if (deleteWt) {
            // Disconnect + unregister + remove worktree
            if (worktreeDirs.has(mergeInfo.worktreePath)) {
              unregisterWorktree(mergeInfo.worktreePath);
              await removeProject(mergeInfo.worktreePath);
            }
            await client.git.removeWorktree(mergeInfo.mainDir, mergeInfo.worktreePath);
          }
          void refreshGitInfo(mergeInfo.mainDir);
        }}
        onFixWithAI={(conflicts) => {
          if (!mergeInfo) return;
          // Start a new session in the main directory and send the conflict resolution prompt
          setActiveTarget(mergeInfo.mainDir);
          // Use a small delay so the active target is set before sending
          if (fixWithAiTimeoutRef.current !== null) {
            window.clearTimeout(fixWithAiTimeoutRef.current);
          }
          fixWithAiTimeoutRef.current = window.setTimeout(() => {
            const fileList = conflicts.map((f) => `- ${f}`).join("\n");
            void sendPrompt(
              `There are git merge conflicts from merging branch "${mergeInfo.branch}" into the current branch.\n\nThe following files have unresolved conflicts:\n${fileList}\n\nPlease resolve all merge conflicts in these files. Remove all conflict markers (<<<<<<, ======, >>>>>>) and produce the correct merged code. After resolving all conflicts, stage the resolved files with \`git add\` for each file.`,
            );
            fixWithAiTimeoutRef.current = null;
          }, POST_MERGE_DELAY_MS);
        }}
      />
      {/* Post-creation worktree setup dialog */}
      <WorktreeSetupDialog
        open={setupWorktreePath !== null}
        onOpenChange={(open) => {
          if (!open) setSetupWorktreePath(null);
        }}
        worktreePath={setupWorktreePath ?? ""}
      />
    </Sidebar>
  );
}
