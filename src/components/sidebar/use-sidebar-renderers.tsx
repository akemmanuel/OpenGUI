import { SessionRow } from "./SessionRow";
import { ProjectEntry } from "./ProjectEntry";
import type { Session } from "@/hooks/agent-state-types";
import type {
  ProjectMetaMap,
  SessionMetaMap,
  SessionColor,
  WorktreeParentMap,
} from "@/hooks/agent-state-persistence";
import type { OpenGuiClient } from "@/protocol/client";
import type { ProjectHydrationState } from "@/hooks/agent-project-hydration";
import type { ConnectionStatus, GitWorktree } from "@/types/electron";
import type { SidebarCollapsedProjects } from "@/lib/sidebar-collapsed";

interface UseSidebarRenderersArgs {
  activeSessionId: string | null;
  availableProjectDirectories: string[];
  busySessionIds: Set<string>;
  cancelEditing: () => void;
  client: OpenGuiClient;
  closeMobileSidebar: () => void;
  closeOtherProjects: (directory: string) => void | Promise<void>;
  collapsed: SidebarCollapsedProjects;
  commitRename: () => void;
  connections: Record<string, ConnectionStatus>;
  deleteSession: (sessionId: string) => void | Promise<void>;
  detachedProject?: string;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  editValue: string;
  editingSessionId: string | null;
  hasActiveSearch: boolean;
  hasUnsentDraft: (sessionId: string) => boolean;
  homeDir?: string | null;
  isGitRepo: Record<string, boolean>;
  isLocalWorkspace: boolean;
  knownWorktrees: Record<string, GitWorktree[]>;
  moveSessionToProject: (sessionId: string, projectDirectory: string) => void | Promise<void>;
  namingSessionIds: Set<string>;
  pendingPermissions: Record<string, unknown>;
  pendingQuestions: Record<string, unknown>;
  projectMeta: ProjectMetaMap;
  projectHydration: Record<string, ProjectHydrationState | undefined>;
  queuedPrompts: Record<string, unknown[]>;
  refreshGitInfo: (directory: string) => void | Promise<void>;
  remoteUrls: Record<string, string>;
  removeProject: (directory: string) => void | Promise<void>;
  removeSessionFromProject: (sessionId: string) => void | Promise<void>;
  revealSessionInProject: (directory: string) => void;
  selectSession: (sessionId: string) => void | Promise<void>;
  sessionMeta: SessionMetaMap;
  setActiveTarget: (directory: string, harnessId?: null, options?: { newChat?: boolean }) => void;
  setEditValue: (value: string) => void;
  setMergeInfo: React.Dispatch<
    React.SetStateAction<{ mainDir: string; branch: string; worktreePath: string } | null>
  >;
  setProjectPinned: (directory: string, pinned: boolean) => void;
  setProjectPopover: React.Dispatch<
    React.SetStateAction<{ directory: string; top: number } | null>
  >;
  setSessionColor: (sessionId: string, color: SessionColor) => void;
  setSessionPinned: (sessionId: string, pinned: boolean) => void;
  setSessionTags: (sessionId: string, tags: string[]) => void;
  setVisibleByProject: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setWorktreeDialogDir: (directory: string) => void;
  sidebarState: "expanded" | "collapsed";
  startEditing: (sessionId: string, currentTitle: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  toggleCollapsed: (directory: string) => void;
  unreadSessionIds: Set<string>;
  unregisterWorktree: (directory: string) => void;
  visibleByProject: Record<string, number>;
  worktreeDirs: Set<string>;
  worktreeParents: WorktreeParentMap;
  workspaceId?: string | null;
}

export function useSidebarRenderers(args: UseSidebarRenderersArgs) {
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
    workspaceId,
  } = args;

  const renderSessionRow: (
    session: Session,
    _directory?: string,
    options?: { currentProjectDir?: string | null },
  ) => React.ReactNode = (
    session: Session,
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

  const renderProjectEntry: (
    directory: string,
    dirSessions: Session[],
    options?: { canDrag?: boolean; dragHandleProps?: Record<string, unknown> },
  ) => React.ReactNode = (
    directory: string,
    dirSessions: Session[],
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
      workspaceId={workspaceId}
      projectHydration={projectHydration}
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
