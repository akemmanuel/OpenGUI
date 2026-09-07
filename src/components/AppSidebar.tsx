import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Sidebar, SidebarContent, useSidebar } from "@/components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getSessionExecutionDirectory } from "@/hooks/agent-session-utils";
import { useHomeDir } from "@/hooks/use-home-dir";
import { useActions, useSessionState, useWorkspaceState } from "@/hooks/use-agent-state";
import { useOutsideClick } from "@/hooks/use-outside-click";
import { SESSION_PAGE_SIZE } from "@/lib/constants";
import { openAddWorkspaceDialog } from "@/hooks/workspace-guards";
import { notifyInfo, notifyUnknownError } from "@/lib/notify";
import { getProjectName, normalizeProjectPath } from "@/lib/path";
import { useRespondingSidebarEnabled } from "@/lib/responding-sidebar";
import { ProjectPathDialog, requestProjectPath } from "./ProjectPathDialog";
import { CollapsedProjectPopover } from "./sidebar/CollapsedProjectPopover";
import { SidebarContentSections } from "./sidebar/SidebarContentSections";
import { RespondingSidebarSections } from "./sidebar/RespondingSidebarSections";
import { SidebarFooterContent } from "./sidebar/SidebarFooterContent";
import { SidebarHeaderContent } from "./sidebar/SidebarHeaderContent";
import { SessionBulkActionBar } from "./sidebar/SessionBulkActionBar";
import {
  EMPTY_SESSION_MULTI_SELECT,
  pruneSessionSelection,
  selectSessionRange,
  toggleSessionSelection,
} from "./sidebar/session-multi-select";
import { isSidebarProjectCollapsed } from "@/lib/persistence/sidebar";
import { sessionUiPermissions } from "./sidebar/SessionRow";
import { useSidebarCollapsedProjects } from "./sidebar/use-sidebar-collapsed-projects";
import { useSidebarRename } from "./sidebar/use-sidebar-rename";
import { useSidebarRenderers } from "./sidebar/use-sidebar-renderers";
import { sortSessionsByResponseState, useSidebarModel } from "./sidebar/use-sidebar-model";
import { useSessionMessageSearch } from "./sidebar/use-session-message-search";

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
  const respondingSidebarEnabled = useRespondingSidebarEnabled();
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
    searchSessionMessages,
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
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const executionDirectory =
    getSessionExecutionDirectory(activeSession) || activeTargetDirectory || null;
  const activeSessionSidebarMeta = activeSession ? sessionMeta[activeSession.id] : undefined;
  const activeSessionIsChat = activeSession
    ? activeSessionSidebarMeta?.sidebarSection === "chats" ||
      (!activeSessionSidebarMeta?.sidebarSection &&
        normalizeProjectPath(getSessionExecutionDirectory(activeSession) ?? "") ===
          normalizeProjectPath(defaultChatDirectory ?? ""))
    : normalizeProjectPath(activeTargetDirectory ?? "") ===
      normalizeProjectPath(defaultChatDirectory ?? "");
  const activeSessionDirectory = activeSessionIsChat
    ? null
    : activeSessionSidebarMeta?.displayProjectDir || executionDirectory;

  const {
    matchingSessionIds: messageMatchingSessionIds,
    effectiveQuery: effectiveSearchQuery,
    isPending: isMessageSearchPending,
  } = useSessionMessageSearch({
    sessions,
    query: searchQuery,
    searchSessionMessages,
  });
  const {
    hasActiveSearch,
    availableProjectDirectories,
    filteredChatSessions,
    flatSessions,
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
    searchQuery: effectiveSearchQuery,
    messageMatchingSessionIds,
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
  const [visibleFlatCount, setVisibleFlatCount] = useState(SESSION_PAGE_SIZE);
  const [selectedProjectDirectory, setSelectedProjectDirectory] = useState("");
  const orderedFlatSessions = useMemo(() => {
    const selected = normalizeProjectPath(selectedProjectDirectory);
    const scoped = selected
      ? flatSessions.filter(
          (session) =>
            normalizeProjectPath(getSessionExecutionDirectory(session) ?? "") === selected,
        )
      : flatSessions;
    return sortSessionsByResponseState(scoped, sessionMeta, unreadSessionIds, busySessionIds);
  }, [busySessionIds, flatSessions, selectedProjectDirectory, sessionMeta, unreadSessionIds]);
  const visibleFlatSessions = orderedFlatSessions.slice(0, visibleFlatCount);
  const respondingSessions = visibleFlatSessions.filter((session) =>
    unreadSessionIds.has(session.id),
  );
  const workingSessions = visibleFlatSessions.filter(
    (session) => !unreadSessionIds.has(session.id) && busySessionIds.has(session.id),
  );
  const idleSessions = visibleFlatSessions.filter(
    (session) => !unreadSessionIds.has(session.id) && !busySessionIds.has(session.id),
  );
  const [multiSelect, setMultiSelect] = useState(EMPTY_SESSION_MULTI_SELECT);
  const selectionAreaRef = useRef<HTMLDivElement | null>(null);
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
  const visibleSessionIds = useMemo(() => {
    const ids: string[] = [];
    const add = (id: string) => {
      if (!ids.includes(id)) ids.push(id);
    };
    if (respondingSidebarEnabled) {
      for (const session of visibleFlatSessions) add(session.id);
      return ids;
    }
    for (const entry of pinnedEntries) {
      if (entry.kind === "session") add(entry.session.id);
      else if (hasActiveSearch || !isSidebarProjectCollapsed(collapsed, entry.directory)) {
        for (const session of entry.sessions.slice(
          0,
          visibleByProject[entry.directory] ?? SESSION_PAGE_SIZE,
        ))
          add(session.id);
      }
    }
    for (const session of visibleChatSessions) add(session.id);
    for (const [directory, projectSessions] of filteredProjectEntries) {
      if (!hasActiveSearch && isSidebarProjectCollapsed(collapsed, directory)) continue;
      for (const session of projectSessions.slice(
        0,
        visibleByProject[directory] ?? SESSION_PAGE_SIZE,
      ))
        add(session.id);
    }
    return ids;
  }, [
    collapsed,
    filteredProjectEntries,
    hasActiveSearch,
    pinnedEntries,
    respondingSidebarEnabled,
    visibleByProject,
    visibleChatSessions,
    visibleFlatSessions,
  ]);
  const clearSessionSelection = useCallback(() => setMultiSelect(EMPTY_SESSION_MULTI_SELECT), []);
  const onPlainSessionClick = useCallback(
    (sessionId: string) => setMultiSelect({ selectedIds: new Set(), anchorId: sessionId }),
    [],
  );
  useEffect(
    () => setMultiSelect((state) => pruneSessionSelection(state, visibleSessionIds)),
    [visibleSessionIds],
  );
  useOutsideClick(
    selectionAreaRef,
    clearSessionSelection,
    multiSelect.selectedIds.size > 0,
    "[data-session-selection-ui]",
  );
  const onSessionSelectionClick = useCallback(
    (sessionId: string, event: React.MouseEvent<HTMLButtonElement>) => {
      setMultiSelect((state) =>
        event.shiftKey
          ? selectSessionRange(state, sessionId, visibleSessionIds)
          : toggleSessionSelection(state, sessionId),
      );
    },
    [visibleSessionIds],
  );
  const selectedSessions = sessions.filter((session) => multiSelect.selectedIds.has(session.id));
  const manageableSessions = selectedSessions.filter(
    (session) => sessionUiPermissions(session._accessRole).manage,
  );
  const deletableSessions = selectedSessions.filter(
    (session) => sessionUiPermissions(session._accessRole).delete,
  );
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
    selectedSessionIds: multiSelect.selectedIds,
    onSessionSelectionClick,
    onPlainSessionClick,
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
      <div ref={selectionAreaRef} className="flex min-h-0 flex-1 flex-col">
        <SidebarHeaderContent
          searchInputRef={searchInputRef}
          searchQuery={searchQuery}
          hasActiveSearch={searchQuery.trim().length > 0}
          detachedProject={detachedProject}
          showChatsSection={
            availableProjectDirectories.length > 0 && (showChatsSection || respondingSidebarEnabled)
          }
          labels={{
            searchPlaceholder: t("sidebar.searchPlaceholder"),
            clearSearch: t("sidebar.clearSearch"),
            newChat: t("sidebar.newChat"),
          }}
          setSearchQuery={setSearchQuery}
          onOpenChat={onOpenChat}
          startNewChat={startNewChat}
          closeMobileSidebar={closeMobileSidebar}
          projectSelector={
            respondingSidebarEnabled && sidebarState !== "collapsed" ? (
              <div className="group-data-[collapsible=icon]:hidden flex h-9 items-center gap-1 border-b border-sidebar-border/60 px-2">
                <Select
                  value={selectedProjectDirectory || "__all_projects__"}
                  onValueChange={(value) => {
                    const directory = value === "__all_projects__" ? "" : value;
                    setSelectedProjectDirectory(directory);
                    setVisibleFlatCount(SESSION_PAGE_SIZE);
                    if (directory) setActiveTarget(directory);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={t("sidebar.projectFilter")}
                    className="h-7 min-w-0 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent dark:hover:bg-sidebar-accent"
                  >
                    <SelectValue>
                      {selectedProjectDirectory
                        ? getProjectName(selectedProjectDirectory)
                        : t("sidebar.allProjects")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectItem value="__all_projects__">{t("sidebar.allProjects")}</SelectItem>
                    {availableProjectDirectories.map((directory) => (
                      <SelectItem key={directory} value={directory}>
                        {getProjectName(directory)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!detachedProject && selectedProjectDirectory && (
                  <button
                    type="button"
                    aria-label={t("projectMenu.removeProject")}
                    title={t("projectMenu.removeProject")}
                    onClick={() => {
                      const directory = selectedProjectDirectory;
                      setSelectedProjectDirectory("");
                      setVisibleFlatCount(SESSION_PAGE_SIZE);
                      void removeProject(directory);
                    }}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
                {!detachedProject && (
                  <button
                    type="button"
                    aria-label={t("sidebar.addProject")}
                    title={t("sidebar.addProject")}
                    onClick={() => void handleAddProject()}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                  >
                    <Plus className="size-3.5" />
                  </button>
                )}
              </div>
            ) : undefined
          }
          selectionActions={
            multiSelect.selectedIds.size > 0 && sidebarState !== "collapsed" ? (
              <SessionBulkActionBar
                count={multiSelect.selectedIds.size}
                canManage={manageableSessions.length > 0}
                canDelete={deletableSessions.length > 0}
                allPinned={
                  manageableSessions.length > 0 &&
                  manageableSessions.every((session) => !!sessionMeta[session.id]?.pinnedAt)
                }
                projects={availableProjectDirectories}
                onTogglePin={() => {
                  const unpin =
                    manageableSessions.length > 0 &&
                    manageableSessions.every((session) => !!sessionMeta[session.id]?.pinnedAt);
                  for (const session of manageableSessions) setSessionPinned(session.id, !unpin);
                }}
                onSetColor={(color) => {
                  for (const session of manageableSessions) setSessionColor(session.id, color);
                }}
                onAddTag={() => {
                  const tag = window.prompt(t("sessionMenu.addTagPrompt"))?.trim();
                  if (!tag) return;
                  for (const session of manageableSessions)
                    setSessionTags(session.id, [
                      ...new Set([...(sessionMeta[session.id]?.tags ?? []), tag]),
                    ]);
                }}
                onMove={(directory) => {
                  revealSessionInProject(directory);
                  for (const session of manageableSessions)
                    void moveSessionToProject(session.id, directory);
                }}
                onDelete={() => {
                  if (
                    deletableSessions.length === 0 ||
                    !window.confirm(
                      t("sessionMenu.deleteSessionsConfirm", {
                        count: deletableSessions.length,
                      }),
                    )
                  )
                    return;
                  void Promise.allSettled(
                    deletableSessions.map((session) => deleteSession(session.id)),
                  );
                  clearSessionSelection();
                }}
                onClear={clearSessionSelection}
              />
            ) : undefined
          }
        />

        <SidebarContent className="overflow-x-hidden" onClickCapture={onOpenChat}>
          {respondingSidebarEnabled ? (
            <RespondingSidebarSections
              respondingSessions={respondingSessions}
              workingSessions={workingSessions}
              idleSessions={idleSessions}
              totalSessionCount={orderedFlatSessions.length}
              visibleSessionCount={visibleFlatCount}
              hasActiveSearch={hasActiveSearch}
              isMessageSearchPending={isMessageSearchPending}
              labels={{
                responding: t("sidebar.responding"),
                working: t("sidebar.working"),
                chats: t("sidebar.chats"),
                noMatches: t("sidebar.noMatches", { query: searchQuery.trim() }),
                noChats: t("sidebar.noChats"),
                loadMore: (count) => t("sidebar.loadMore", { count }),
                showLess: t("sidebar.showLess"),
              }}
              renderSessionRow={renderSessionRow}
              setVisibleSessionCount={setVisibleFlatCount}
            />
          ) : (
            <SidebarContentSections
              pinnedEntries={pinnedEntries}
              filteredChatSessions={filteredChatSessions}
              visibleChatSessions={visibleChatSessions}
              filteredProjectEntries={filteredProjectEntries}
              hasActiveSearch={hasActiveSearch}
              isMessageSearchPending={isMessageSearchPending}
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
              sidebarCollapsed={sidebarState === "collapsed"}
            />
          )}

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
      </div>

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
