import { FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { useHomeDir } from "@/hooks/use-home-dir";
import { useActions, useConnectionState, useSessionState } from "@/hooks/use-agent-state";
import { useOpenGuiClient } from "@/protocol/provider";
import { useOutsideClick } from "@/hooks/use-outside-click";
import { POST_MERGE_DELAY_MS, SESSION_PAGE_SIZE } from "@/lib/constants";
import {
  getSidebarCollapsedProjects,
  persistSidebarCollapsedProjects,
  pruneSidebarCollapsedProjects,
  toggleSidebarProjectCollapsed,
  type SidebarCollapsedProjects,
} from "@/lib/sidebar-collapsed";
import { abbreviatePath, normalizeProjectPath } from "@/lib/utils";
import { ConnectionPanel } from "./ConnectionPanel";
import { MergeDialog } from "./MergeDialog";
import { ProjectPathDialog } from "./ProjectPathDialog";
import { WorktreeDialog } from "./WorktreeDialog";
import { WorktreeSetupDialog } from "./WorktreeSetupDialog";
import { CollapsedProjectPopover } from "./sidebar/CollapsedProjectPopover";
import { ProjectEntry } from "./sidebar/ProjectEntry";
import { SessionRow } from "./sidebar/SessionRow";
import { SidebarContentSections } from "./sidebar/SidebarContentSections";
import { SidebarHeaderContent } from "./sidebar/SidebarHeaderContent";
import { useProjectGitInfo } from "./sidebar/use-project-git-info";
import { useSidebarModel } from "./sidebar/use-sidebar-model";

export function AppSidebar({
  detachedProject,
  onOpenSettings,
  onOpenChat,
  settingsActive = false,
}: {
  detachedProject?: string;
  onOpenSettings: () => void;
  onOpenChat: () => void;
  settingsActive?: boolean;
}) {
  const client = useOpenGuiClient();
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

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSessionDirectory =
    activeSession?._projectDir ?? activeSession?.directory ?? activeTargetDirectory ?? null;
  const {
    connections,
    worktreeParents,
    projectMeta,
    isLocalWorkspace,
    activeWorkspace,
    workspaceDirectory,
    defaultChatDirectory,
  } = useConnectionState();

  // Inline rename state
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showRemoteProjectInput, setShowRemoteProjectInput] = useState(false);
  const [remoteProjectPath, setRemoteProjectPath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const startEditing = useCallback((sessionId: string, currentTitle: string) => {
    setEditingSessionId(sessionId);
    setEditValue(currentTitle);
  }, []);

  const commitRename = useCallback(() => {
    if (editingSessionId) {
      const trimmed = editValue.trim();
      if (trimmed && trimmed !== editingSessionId) {
        // Find the session to compare with its current title
        const session = sessions.find((s) => s.id === editingSessionId);
        if (trimmed !== (session?.title || "")) {
          void renameSession(editingSessionId, trimmed);
        }
      }
    }
    setEditingSessionId(null);
    setEditValue("");
  }, [editingSessionId, editValue, sessions, renameSession]);

  const cancelEditing = useCallback(() => {
    setEditingSessionId(null);
    setEditValue("");
  }, []);

  const homeDir = useHomeDir();
  const normalizedRemoteProjectPath = normalizeProjectPath(remoteProjectPath);
  const isWebRuntime =
    typeof navigator !== "undefined" && !navigator.userAgent.includes("Electron");
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
  const {
    hasActiveSearch,
    availableProjectDirectories,
    filteredChatSessions,
    pinnedEntries,
    projectEntries: filteredProjectEntries,
    projectSessionsByDirectory,
  } = useSidebarModel({
    sessions,
    sessionMeta,
    projectMeta,
    worktreeParents,
    activeWorkspace,
    connections,
    detachedProject,
    defaultChatDirectory,
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

  // Track collapsed state per project
  const [collapsed, setCollapsed] = useState<SidebarCollapsedProjects>(() =>
    getSidebarCollapsedProjects(),
  );
  const toggleCollapsed = useCallback((dir: string) => {
    setCollapsed((prev) => toggleSidebarProjectCollapsed(prev, dir));
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
  useEffect(() => {
    // Keep collapsed project state across app startup. Connections hydrate after
    // frontend-persisted state, so pruning against an empty/partial connection list can
    // delete saved collapsed projects before they reconnect. Use persisted
    // workspace project list when available, and never let detached windows prune
    // shared sidebar state for other projects.
    if (detachedProject) return;
    const collapsedPruneDirectories =
      activeWorkspaceProjectDirectories.length > 0
        ? activeWorkspaceProjectDirectories
        : openDirectories;
    if (collapsedPruneDirectories.length === 0) return;

    setCollapsed((prev) => {
      const next = pruneSidebarCollapsedProjects(prev, collapsedPruneDirectories);
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length === nextKeys.length && nextKeys.every((directory) => prev[directory])) {
        return prev;
      }
      return next;
    });
  }, [activeWorkspaceProjectDirectories, detachedProject, openDirectories]);
  useEffect(() => {
    persistSidebarCollapsedProjects(collapsed);
  }, [collapsed]);
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
      setSidebarOpen(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };

    window.addEventListener("focus-sidebar-search", focusSidebarSearch);
    return () => {
      window.removeEventListener("focus-sidebar-search", focusSidebarSearch);
    };
  }, [setSidebarOpen]);

  const handleAddProject = useCallback(async () => {
    const dir =
      isLocalWorkspace && !isWebRuntime
        ? await openDirectory()
        : await requestProjectPath(workspaceDirectory ?? undefined);
    if (dir) void connectToProject(dir);
  }, [
    connectToProject,
    isLocalWorkspace,
    isWebRuntime,
    openDirectory,
    requestProjectPath,
    workspaceDirectory,
  ]);

  const hasUnsentDraft = useCallback(
    (sessionId: string) => Boolean(sessionDrafts[`session:${sessionId}`]?.trim()),
    [sessionDrafts],
  );

  const revealSessionInProject = useCallback((directory: string) => {
    const normalizedDirectory = normalizeProjectPath(directory);
    if (!normalizedDirectory) return;
    setCollapsed((prev) => {
      if (!prev[normalizedDirectory]) return prev;
      const { [normalizedDirectory]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const renderSessionRow = (session: (typeof sessions)[number], _directory: string) => (
    <SessionRow
      key={session.id}
      session={session}
      activeSessionId={activeSessionId}
      busySessionIds={busySessionIds}
      unreadSessionIds={unreadSessionIds}
      queuedPrompts={queuedPrompts}
      pendingQuestions={pendingQuestions}
      pendingPermissions={pendingPermissions}
      sessionMeta={sessionMeta}
      namingSessionIds={namingSessionIds}
      worktreeParents={worktreeParents}
      knownWorktrees={knownWorktrees}
      availableProjectDirectories={availableProjectDirectories}
      editingSessionId={editingSessionId}
      editValue={editValue}
      editInputRef={editInputRef}
      untitledLabel={t("sidebar.untitled")}
      hasUnsentDraft={hasUnsentDraft}
      selectSession={selectSession}
      closeMobileSidebar={closeMobileSidebar}
      setEditValue={setEditValue}
      commitRename={commitRename}
      cancelEditing={cancelEditing}
      startEditing={startEditing}
      setSessionPinned={setSessionPinned}
      setSessionColor={setSessionColor}
      setSessionTags={setSessionTags}
      revealSessionInProject={revealSessionInProject}
      moveSessionToProject={moveSessionToProject}
      deleteSession={deleteSession}
    />
  );

  const renderProjectEntry = (
    directory: string,
    dirSessions: typeof sessions,
    options?: { canDrag?: boolean; dragHandleProps?: Record<string, unknown> },
  ) => (
    <ProjectEntry
      key={directory}
      directory={directory}
      dirSessions={dirSessions}
      canDrag={options?.canDrag}
      dragHandleProps={options?.dragHandleProps}
      hasActiveSearch={hasActiveSearch}
      collapsed={collapsed}
      connections={connections}
      visibleByProject={visibleByProject}
      sidebarState={sidebarState}
      homeDir={homeDir}
      detachedProject={detachedProject}
      isLocalWorkspace={isLocalWorkspace}
      isGitRepo={isGitRepo}
      knownWorktrees={knownWorktrees}
      availableProjectDirectories={availableProjectDirectories}
      worktreeParents={worktreeParents}
      remoteUrls={remoteUrls}
      worktreeDirs={worktreeDirs}
      projectMeta={projectMeta}
      client={client}
      t={t}
      renderSessionRow={renderSessionRow}
      refreshGitInfo={refreshGitInfo}
      setProjectPopover={setProjectPopover}
      toggleCollapsed={toggleCollapsed}
      setActiveTarget={setActiveTarget}
      closeMobileSidebar={closeMobileSidebar}
      setProjectPinned={setProjectPinned}
      removeProject={removeProject}
      closeOtherProjects={closeOtherProjects}
      setWorktreeDialogDir={setWorktreeDialogDir}
      setMergeInfo={setMergeInfo}
      unregisterWorktree={unregisterWorktree}
      setVisibleByProject={setVisibleByProject}
    />
  );

  return (
    <Sidebar collapsible="icon" className="select-none relative">
      <SidebarHeaderContent
        searchInputRef={searchInputRef}
        searchQuery={searchQuery}
        hasActiveSearch={hasActiveSearch}
        detachedProject={detachedProject}
        defaultChatDirectory={defaultChatDirectory}
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
          defaultChatDirectory={defaultChatDirectory}
          visibleChatCount={visibleChatCount}
          hasMoreChats={hasMoreChats}
          canShowLessChats={canShowLessChats}
          worktreeParents={worktreeParents}
          sessionMeta={sessionMeta}
          labels={{
            pinned: t("sidebar.pinned"),
            chats: t("sidebar.chats"),
            projects: projectLabel,
            noMatches: t("sidebar.noMatches", { query: searchQuery.trim() }),
            noChats: t("sidebar.noChats"),
            loadMore: (count) => t("sidebar.loadMore", { count }),
            showLess: t("sidebar.showLess"),
            allProjectsPinned: t("sidebar.allProjectsPinned"),
            noProjectsYet: "No projects yet",
          }}
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
            activeSessionId={activeSessionId}
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

        {/* Remote path input (shown for remote workspaces, independent of project list) */}
        {showRemoteProjectInput && !isLocalWorkspace && !detachedProject && (
          <div className="mx-3 mt-3 space-y-2 rounded-lg border bg-sidebar-accent/30 p-2 group-data-[collapsible=icon]:hidden">
            <div className="text-[11px] text-muted-foreground">
              Remote path on {activeWorkspace?.name}
            </div>
            <div className="flex gap-2">
              <Input
                autoFocus
                value={remoteProjectPath}
                onChange={(event) => setRemoteProjectPath(event.target.value)}
                placeholder="/remote/path/to/project"
                className="h-8 font-mono text-xs"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setRemoteProjectPath("");
                    setShowRemoteProjectInput(false);
                  }
                  if (event.key === "Enter" && normalizedRemoteProjectPath) {
                    event.preventDefault();
                    void connectToProject(normalizedRemoteProjectPath);
                    setRemoteProjectPath("");
                    setShowRemoteProjectInput(false);
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (!normalizedRemoteProjectPath) return;
                  void connectToProject(normalizedRemoteProjectPath);
                  setRemoteProjectPath("");
                  setShowRemoteProjectInput(false);
                }}
                className="flex h-8 items-center rounded-md bg-primary px-3 text-xs text-primary-foreground"
              >
                Open
              </button>
              <button
                type="button"
                onClick={() => {
                  setRemoteProjectPath("");
                  setShowRemoteProjectInput(false);
                }}
                className="flex h-8 items-center rounded-md border px-3 text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </SidebarContent>

      {!detachedProject && (
        <SidebarFooter className="border-t border-sidebar-border p-0 gap-0">
          {activeSessionDirectory && (
            <div
              title={activeSessionDirectory}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-sidebar-border group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-b-0 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-2"
            >
              <FolderOpen className="size-3.5 shrink-0" />
              <span className="truncate min-w-0 group-data-[collapsible=icon]:hidden">
                {abbreviatePath(activeSessionDirectory, homeDir)}
              </span>
            </div>
          )}
          <div className="flex justify-center p-1 group-data-[collapsible=icon]:px-0">
            <ConnectionPanel
              onOpenSettings={() => {
                onOpenSettings();
                closeMobileSidebar();
              }}
              isActive={settingsActive}
            />
          </div>
        </SidebarFooter>
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
