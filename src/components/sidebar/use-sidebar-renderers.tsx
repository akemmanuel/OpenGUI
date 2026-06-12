import { SessionRow } from "./SessionRow";
import { ProjectEntry } from "./ProjectEntry";

export function useSidebarRenderers(args: any) {
  const {
    activeSessionId,
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
  } = args;

  const renderSessionRow = (
    session: any,
    _directory?: string,
    options?: { currentProjectDir?: string | null },
  ) => (
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
      removeSessionFromProject={removeSessionFromProject}
      currentProjectDir={options?.currentProjectDir ?? null}
      deleteSession={deleteSession}
    />
  );

  const renderProjectEntry = (
    directory: string,
    dirSessions: any,
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

  return { renderSessionRow, renderProjectEntry };
}
