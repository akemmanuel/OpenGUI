import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sidebar, SidebarContent, useSidebar } from "@/components/ui/sidebar";
import { getSessionExecutionDirectory } from "@/hooks/agent-session-utils";
import { useHomeDir } from "@/hooks/use-home-dir";
import { useActions, useSessionState, useWorkspaceState } from "@/hooks/use-agent-state";
import { useOutsideClick } from "@/hooks/use-outside-click";
import { SESSION_PAGE_SIZE } from "@/lib/constants";
import { openAddWorkspaceDialog } from "@/hooks/workspace-guards";
import { notifyInfo, notifyUnknownError } from "@/lib/notify";
import { normalizeProjectPath } from "@/lib/path";
import { ProjectPathDialog } from "./ProjectPathDialog";
import { CollapsedProjectPopover } from "./sidebar/CollapsedProjectPopover";
import { SidebarContentSections } from "./sidebar/SidebarContentSections";
import { SidebarFooterContent } from "./sidebar/SidebarFooterContent";
import { SidebarHeaderContent } from "./sidebar/SidebarHeaderContent";
import { useSidebarCollapsedProjects } from "./sidebar/use-sidebar-collapsed-projects";
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
    projectMeta,
    isLocalWorkspace,
    supportsNativeDirectoryPicker,
    activeWorkspace,
    workspaces,
    canManageProjects,
    workspaceDirectory,
    defaultChatDirectory,
    bootState,
  } = useWorkspaceState();

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
    activeWorkspace,
    connections,
    detachedProject,
    defaultChatDirectory,
    searchQuery,
    untitledLabel: t("sidebar.untitled"),
  });

  const openDirectories = useMemo(() => Object.keys(connections), [connections]);
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
    if (!dir) return;
    try {
      await connectToProject(dir);
    } catch (error) {
      notifyUnknownError(error);
    }
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
    isLocalWorkspace,
    moveSessionToProject,
    namingSessionIds,
    pendingPermissions,
    pendingQuestions,
    projectMeta,
    queuedPrompts,
    removeProject,
    removeSessionFromProject,
    revealSessionInProject,
    selectSession,
    sessionMeta,
    setActiveTarget,
    setEditValue,
    setProjectPinned,
    setProjectPopover,
    setSessionColor,
    setSessionPinned,
    setSessionTags,
    setVisibleByProject,
    sidebarState,
    startEditing,
    t,
    toggleCollapsed,
    unreadSessionIds,
    visibleByProject,
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
    </Sidebar>
  );
}
