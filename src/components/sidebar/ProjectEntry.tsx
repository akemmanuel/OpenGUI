import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Folder,
  FolderOpen,
  GripVertical,
  Plus,
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
    <div key={directory} className="group/project-block mb-1.5">
      <SidebarMenu>
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <SidebarMenuItem className="overflow-visible">
              <SidebarRow
                label={getProjectName(directory)}
                className="group/project relative font-medium"
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
                  sidebarState !== "collapsed" ? (
                    <span className="relative flex size-5 shrink-0 items-center justify-center group-data-[collapsible=icon]:hidden">
                      <button
                        type="button"
                        data-project-action
                        className={`flex size-5 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground ${canDrag ? "group-hover/project-block:opacity-0 group-focus-within/project-block:opacity-0" : ""}`}
                        aria-label={getProjectName(directory)}
                        onClick={() => toggleCollapsed(directory)}
                      >
                        <ChevronRight
                          className={`size-3.5 transition-transform ${!isCollapsed ? "rotate-90" : ""}`}
                        />
                      </button>
                      {canDrag && (
                        <button
                          {...(dragHandleProps ?? {})}
                          type="button"
                          data-project-action
                          data-project-drag-handle
                          className="pointer-events-none absolute inset-0 flex size-5 cursor-grab items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/project-block:pointer-events-auto group-hover/project-block:opacity-100 group-focus-within/project-block:pointer-events-auto group-focus-within/project-block:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 active:cursor-grabbing"
                          aria-label={`Reorder ${getProjectName(directory)}`}
                        >
                          <GripVertical className="size-3.5" />
                        </button>
                      )}
                    </span>
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
                  ) : isCollapsed ? (
                    <Folder className="shrink-0 size-4 text-muted-foreground" />
                  ) : (
                    <FolderOpen className="shrink-0 size-4 text-muted-foreground" />
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
        <SidebarMenu className="ml-3 w-[calc(100%-0.75rem)] gap-0.5 overflow-x-hidden pl-2">
          {dirSessions.length === 0 ? (
            <button
              type="button"
              aria-label={t("sidebar.newSession")}
              className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              onClick={() => {
                setActiveTarget(directory, { newChat: true });
                closeMobileSidebar();
              }}
            >
              <Plus className="size-3.5 shrink-0" />
              <span className="truncate">{t("projectMenu.newSession")}</span>
            </button>
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
