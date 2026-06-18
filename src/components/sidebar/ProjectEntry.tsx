import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  GripVertical,
  SquarePen,
} from "lucide-react";
import * as ContextMenu from "@/components/ui/context-menu";
import type { ReactNode } from "react";
import type { OpenGuiClient } from "@/protocol/client";
import type { Session } from "@/hooks/agent-state-types";
import type { ProjectMetaMap, WorktreeParentMap } from "@/hooks/agent-state-persistence";
import { SESSION_PAGE_SIZE } from "@/lib/constants";
import { isSidebarProjectCollapsed, type SidebarCollapsedProjects } from "@/lib/sidebar-collapsed";
import {
  abbreviatePath,
  buildPRUrl,
  getProjectName,
  normalizeProjectPath,
  openExternalLink,
} from "@/lib/utils";
import type { ConnectionStatus, GitWorktree } from "@/types/electron";
import { ProjectItemMenu, ProjectMenuContent } from "@/components/SidebarItemMenus";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import type { ProjectHydrationState } from "@/hooks/agent-project-hydration";
import { listProjectHarnessSessionQueryErrors } from "@/hooks/session-query-errors";
import { makeProjectKey } from "@/hooks/agent-session-utils";
import { isSidebarProjectPinned } from "@/lib/sidebar-project-meta";

export function ProjectEntry({
  directory,
  dirSessions,
  canDrag,
  dragHandleProps,
  hasActiveSearch,
  collapsed,
  connections,
  visibleByProject,
  sidebarState,
  homeDir,
  detachedProject,
  isLocalWorkspace,
  isGitRepo,
  knownWorktrees,
  availableProjectDirectories,
  worktreeParents,
  remoteUrls,
  worktreeDirs,
  projectMeta,
  workspaceId,
  projectHydration,
  client,
  t,
  renderSessionRow,
  refreshGitInfo,
  setProjectPopover,
  toggleCollapsed,
  setActiveTarget,
  closeMobileSidebar,
  setProjectPinned,
  removeProject,
  closeOtherProjects,
  setWorktreeDialogDir,
  setMergeInfo,
  unregisterWorktree,
  setVisibleByProject,
}: {
  directory: string;
  dirSessions: Session[];
  canDrag?: boolean;
  dragHandleProps?: Record<string, unknown>;
  hasActiveSearch: boolean;
  collapsed: SidebarCollapsedProjects;
  connections: Record<string, ConnectionStatus>;
  visibleByProject: Record<string, number>;
  sidebarState: "expanded" | "collapsed";
  homeDir?: string | null;
  detachedProject?: string;
  isLocalWorkspace: boolean;
  isGitRepo: Record<string, boolean>;
  knownWorktrees: Record<string, GitWorktree[]>;
  availableProjectDirectories: string[];
  worktreeParents: WorktreeParentMap;
  remoteUrls: Record<string, string>;
  worktreeDirs: Set<string>;
  projectMeta: ProjectMetaMap;
  workspaceId?: string | null;
  projectHydration: Record<string, ProjectHydrationState | undefined>;
  client: OpenGuiClient;
  t: (key: string, options?: Record<string, unknown>) => string;
  renderSessionRow: (
    session: Session,
    directory: string,
    options?: { currentProjectDir?: string | null },
  ) => ReactNode;
  refreshGitInfo: (directory: string) => void | Promise<void>;
  setProjectPopover: React.Dispatch<
    React.SetStateAction<{ directory: string; top: number } | null>
  >;
  toggleCollapsed: (directory: string) => void;
  setActiveTarget: (directory: string, harnessId?: null, options?: { newChat?: boolean }) => void;
  closeMobileSidebar: () => void;
  setProjectPinned: (directory: string, pinned: boolean) => void;
  removeProject: (directory: string) => void | Promise<void>;
  closeOtherProjects: (directory: string) => void | Promise<void>;
  setWorktreeDialogDir: (directory: string) => void;
  setMergeInfo: React.Dispatch<
    React.SetStateAction<{ mainDir: string; branch: string; worktreePath: string } | null>
  >;
  unregisterWorktree: (directory: string) => void;
  setVisibleByProject: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}) {
  const isCollapsed = hasActiveSearch ? false : isSidebarProjectCollapsed(collapsed, directory);
  const connStatus = connections[directory];
  const isProjectConnected = connStatus?.state === "connected";
  const isProjectConnecting =
    connStatus?.state === "connecting" || connStatus?.state === "reconnecting";
  const visibleCount = visibleByProject[directory] ?? SESSION_PAGE_SIZE;
  const visibleSessions = dirSessions.slice(0, visibleCount);
  const hasMoreSessions = dirSessions.length > visibleCount;
  const canShowLess = visibleCount > SESSION_PAGE_SIZE;
  const normalizedDirectory = normalizeProjectPath(directory);
  const isPinned = isSidebarProjectPinned(projectMeta, workspaceId, directory);
  const harnessErrorCount = workspaceId
    ? listProjectHarnessSessionQueryErrors(
        projectHydration[makeProjectKey(workspaceId, normalizedDirectory)],
      ).length
    : 0;
  const canCloseOtherProjects = availableProjectDirectories.some(
    (projectDirectory) => normalizeProjectPath(projectDirectory) !== normalizedDirectory,
  );

  const openWorktreePr = (wt: { path: string; branch?: string | null }) => {
    if (!wt.branch) return;
    const remote = remoteUrls[directory];
    if (!remote) return;
    const url = buildPRUrl(remote, wt.branch);
    if (url) openExternalLink(url);
  };

  const removeWorktree = async (wt: { path: string; branch?: string | null }) => {
    if (worktreeDirs.has(wt.path)) {
      unregisterWorktree(wt.path);
      await removeProject(wt.path);
    }
    await client.git.removeWorktree(directory, wt.path);
    void refreshGitInfo(directory);
  };

  const projectMenuProps: React.ComponentProps<typeof ProjectItemMenu> = {
    pinned: isPinned,
    collapsed: isCollapsed,
    canCreateSession: isProjectConnected,
    onTogglePin: () => setProjectPinned(directory, !isPinned),
    onNewSession: () => {
      setActiveTarget(directory, undefined, { newChat: true });
      closeMobileSidebar();
    },
    onToggleCollapsed: () => toggleCollapsed(directory),
    canRemove: !detachedProject,
    onRemove: () => {
      if (detachedProject) return;
      void removeProject(directory);
    },
    canCloseOtherProjects: !detachedProject && canCloseOtherProjects,
    onCloseOtherProjects: () => {
      if (detachedProject) return;
      void closeOtherProjects(directory);
    },
    directory,
    isLocalWorkspace,
    isGitRepo: !!isGitRepo[directory],
    worktrees: knownWorktrees[directory] ?? [],
    worktreeParents,
    onNewWorktree: () => setWorktreeDialogDir(directory),
    onMergeWorktree: (wt) => {
      if (!wt.branch) return;
      setMergeInfo({ mainDir: directory, branch: wt.branch, worktreePath: wt.path });
    },
    onOpenWorktreePr: openWorktreePr,
    onRemoveWorktree: removeWorktree,
  };

  return (
    <div key={directory} className="mb-1">
      <SidebarMenu>
        <ContextMenu.Root
          onOpenChange={(open) => {
            if (open) void refreshGitInfo(directory);
          }}
        >
          <ContextMenu.Trigger asChild>
            <SidebarMenuItem className="overflow-visible">
              <SidebarMenuButton
                asChild
                tooltip={abbreviatePath(directory, homeDir ?? "")}
                className="group/project font-medium min-w-0"
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    const target = event.target;
                    if (target instanceof Element && target.closest("[data-project-action]")) {
                      return;
                    }
                    if (sidebarState === "collapsed") {
                      event.preventDefault();
                      event.stopPropagation();
                      const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
                      setProjectPopover((prev) =>
                        prev?.directory === directory ? null : { directory, top: rect.top },
                      );
                      return;
                    }
                    toggleCollapsed(directory);
                  }}
                  onKeyDown={(event) => {
                    const target = event.target;
                    if (target instanceof Element && target.closest("[data-project-action]")) {
                      return;
                    }
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleCollapsed(directory);
                    }
                  }}
                >
                  {isProjectConnecting ? (
                    <Spinner className="shrink-0 size-4 text-muted-foreground" />
                  ) : canDrag ? (
                    <span className="relative -ml-1 flex size-5 shrink-0 items-center justify-center">
                      <ChevronRight
                        className={`size-4 transition-all group-hover/project:scale-75 group-hover/project:opacity-0 ${
                          !isCollapsed ? "rotate-90" : ""
                        }`}
                      />
                      <span
                        {...(dragHandleProps ?? {})}
                        data-project-action
                        data-project-drag-handle
                        className="absolute inset-0 flex cursor-grab items-center justify-center rounded text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground active:cursor-grabbing group-hover/project:opacity-100"
                        aria-label={`Reorder ${getProjectName(directory)}`}
                      >
                        <GripVertical className="size-3.5" />
                      </span>
                    </span>
                  ) : sidebarState === "collapsed" ? (
                    <FolderOpen className="shrink-0 size-4" />
                  ) : (
                    <ChevronRight
                      className={`shrink-0 size-4 transition-transform ${!isCollapsed ? "rotate-90" : ""}`}
                    />
                  )}
                  <span className="truncate min-w-0 flex-1">{getProjectName(directory)}</span>
                  {harnessErrorCount > 0 && (
                    <span
                      className="shrink-0 text-[10px] font-medium text-destructive group-data-[collapsible=icon]:hidden"
                      title={t("projectHarnessStatus.sidebarSummary", { count: harnessErrorCount })}
                    >
                      {t("projectHarnessStatus.sidebarSummary", { count: harnessErrorCount })}
                    </span>
                  )}
                  {isProjectConnected && (
                    <div
                      role="button"
                      data-project-action
                      tabIndex={0}
                      className="ml-auto opacity-0 group-hover/project:opacity-100 transition-opacity shrink-0 size-6 rounded-md flex items-center justify-center hover:bg-accent group-data-[collapsible=icon]:hidden"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveTarget(directory, undefined, { newChat: true });
                        closeMobileSidebar();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.stopPropagation();
                          setActiveTarget(directory, undefined, { newChat: true });
                          closeMobileSidebar();
                        }
                      }}
                    >
                      <SquarePen className="size-3" />
                    </div>
                  )}
                  <ProjectItemMenu {...projectMenuProps} />
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content
              className="z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
              alignOffset={5}
            >
              <ProjectMenuContent kind="context" {...projectMenuProps} />
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      </SidebarMenu>
      {!isCollapsed && sidebarState !== "collapsed" && (
        <SidebarMenu className="ml-3 border-l border-sidebar-border pl-2 w-[calc(100%-0.75rem)] overflow-x-hidden">
          {dirSessions.length === 0 ? (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              {t("sidebar.noSessionsYet")}
            </div>
          ) : (
            <>
              {visibleSessions.map((session) =>
                renderSessionRow(session, directory, { currentProjectDir: directory }),
              )}
              {hasMoreSessions && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => {
                      setVisibleByProject((prev) => ({
                        ...prev,
                        [directory]: (prev[directory] ?? SESSION_PAGE_SIZE) + SESSION_PAGE_SIZE,
                      }));
                    }}
                    className="text-muted-foreground min-w-0"
                  >
                    <ChevronDown className="shrink-0" />
                    <span className="truncate">
                      {t("sidebar.loadMore", { count: dirSessions.length - visibleCount })}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {canShowLess && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => {
                      setVisibleByProject((prev) => ({ ...prev, [directory]: SESSION_PAGE_SIZE }));
                    }}
                    className="text-muted-foreground min-w-0"
                  >
                    <ChevronUp className="shrink-0" />
                    <span className="truncate">{t("sidebar.showLess")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </>
          )}
        </SidebarMenu>
      )}
    </div>
  );
}
