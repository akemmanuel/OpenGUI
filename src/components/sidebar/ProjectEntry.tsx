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
import type { Session } from "@/hooks/agent-state-types";
import type { ProjectMetaMap } from "@/lib/persistence/project";
import { SESSION_PAGE_SIZE } from "@/lib/constants";
import {
  isSidebarProjectCollapsed,
  type SidebarCollapsedProjects,
} from "@/lib/persistence/sidebar";
import { getProjectName, normalizeProjectPath } from "@/lib/path";
import type { ConnectionStatus } from "@/types/connection";
import { ProjectItemMenu, ProjectMenuContent } from "@/components/SidebarItemMenus";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { makeProjectKey } from "@/hooks/agent-session-utils";
import { isSidebarProjectPinned } from "@/lib/persistence/project";
import { SidebarRow } from "./SidebarRow";

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
  detachedProject,
  isLocalWorkspace,
  availableProjectDirectories,
  projectMeta,
  workspaceId,
  t,
  renderSessionRow,
  setProjectPopover,
  toggleCollapsed,
  setActiveTarget,
  closeMobileSidebar,
  setProjectPinned,
  removeProject,
  closeOtherProjects,
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
  detachedProject?: string;
  isLocalWorkspace: boolean;
  availableProjectDirectories: string[];
  projectMeta: ProjectMetaMap;
  workspaceId?: string | null;
  t: (key: string, options?: Record<string, unknown>) => string;
  renderSessionRow: (
    session: Session,
    directory: string,
    options?: { currentProjectDir?: string | null },
  ) => ReactNode;
  setProjectPopover: React.Dispatch<
    React.SetStateAction<{ directory: string; top: number } | null>
  >;
  toggleCollapsed: (directory: string) => void;
  setActiveTarget: (directory: string, options?: { newChat?: boolean }) => void;
  closeMobileSidebar: () => void;
  setProjectPinned: (directory: string, pinned: boolean) => void;
  removeProject: (directory: string) => void | Promise<void>;
  closeOtherProjects: (directory: string) => void | Promise<void>;
  setVisibleByProject: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}) {
  const isCollapsed = hasActiveSearch ? false : isSidebarProjectCollapsed(collapsed, directory);
  const projectKey = makeProjectKey(workspaceId, directory);
  const connStatus = connections[projectKey] ?? connections[directory];
  const isProjectConnected = connStatus?.state === "connected";
  const isProjectConnecting =
    connStatus?.state === "connecting" || connStatus?.state === "reconnecting";
  const visibleCount = visibleByProject[directory] ?? SESSION_PAGE_SIZE;
  const visibleSessions = dirSessions.slice(0, visibleCount);
  const hasMoreSessions = dirSessions.length > visibleCount;
  const canShowLess = visibleCount > SESSION_PAGE_SIZE;
  const normalizedDirectory = normalizeProjectPath(directory);
  const isPinned = isSidebarProjectPinned(projectMeta, workspaceId, directory);
  const canCloseOtherProjects = availableProjectDirectories.some(
    (projectDirectory) => normalizeProjectPath(projectDirectory) !== normalizedDirectory,
  );

  const projectMenuProps: React.ComponentProps<typeof ProjectItemMenu> = {
    pinned: isPinned,
    collapsed: isCollapsed,
    canCreateSession: isProjectConnected,
    onTogglePin: () => setProjectPinned(directory, !isPinned),
    onNewSession: () => {
      setActiveTarget(directory, { newChat: true });
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
  };

  return (
    <div key={directory} className="mb-1">
      <SidebarMenu>
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <SidebarMenuItem className="overflow-visible">
              <SidebarRow
                label={getProjectName(directory)}
                className="group/project font-medium"
                onActivate={(event) => {
                  if (sidebarState === "collapsed") {
                    const top = event.currentTarget.getBoundingClientRect().top;
                    setProjectPopover((prev) =>
                      prev?.directory === directory ? null : { directory, top },
                    );
                    return;
                  }
                  toggleCollapsed(directory);
                }}
                leadingAction={
                  canDrag ? (
                    <button
                      {...(dragHandleProps ?? {})}
                      type="button"
                      data-project-action
                      data-project-drag-handle
                      className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground active:cursor-grabbing group-data-[collapsible=icon]:hidden"
                      aria-label={`Reorder ${getProjectName(directory)}`}
                    >
                      <GripVertical className="size-3.5" />
                    </button>
                  ) : undefined
                }
                actions={
                  <>
                    {isProjectConnected && (
                      <button
                        type="button"
                        data-project-action
                        data-slot="sidebar-hover-action"
                        data-responsive-allow="hover-reveal"
                        className="opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0 size-6 rounded-md flex items-center justify-center hover:bg-accent group-data-[collapsible=icon]:hidden"
                        aria-label={t("projectMenu.newSession")}
                        onClick={() => {
                          setActiveTarget(directory, { newChat: true });
                          closeMobileSidebar();
                        }}
                      >
                        <SquarePen className="size-3" />
                      </button>
                    )}
                    <ProjectItemMenu {...projectMenuProps} />
                  </>
                }
              >
                <span data-project-directory={directory} className="contents">
                  {isProjectConnecting ? (
                    <Spinner className="shrink-0 size-4 text-muted-foreground" />
                  ) : sidebarState === "collapsed" ? (
                    <FolderOpen className="shrink-0 size-4" />
                  ) : (
                    <ChevronRight
                      className={`shrink-0 size-4 transition-transform ${!isCollapsed ? "rotate-90" : ""}`}
                    />
                  )}
                  <span className="truncate min-w-0 flex-1" data-responsive-allow="text-clip">
                    {getProjectName(directory)}
                  </span>
                </span>
              </SidebarRow>
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
