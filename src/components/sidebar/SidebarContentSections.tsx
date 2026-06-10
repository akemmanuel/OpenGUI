import { ChevronDown, ChevronUp, Plus, SquarePen } from "lucide-react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { ReactNode } from "react";
import type { Session } from "@/hooks/agent-state-types";
import { SESSION_PAGE_SIZE } from "@/lib/constants";
import { getSessionExecutionDirectory, getSessionPlacementInfo } from "@/lib/worktree-placement";
import type { SessionMetaMap, WorktreeParentMap } from "@/hooks/agent-state-persistence";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { SortableProjectFrame } from "@/components/sidebar/SortableProjectFrame";

type ProjectEntryTuple = readonly [string, Session[]];
type PinnedEntry =
  | { kind: "project"; directory: string; sessions: Session[] }
  | { kind: "session"; session: Session; projectDirectory: string };

export function SidebarContentSections({
  pinnedEntries,
  filteredChatSessions,
  visibleChatSessions,
  filteredProjectEntries,
  hasActiveSearch,
  detachedProject,
  defaultChatDirectory,
  visibleChatCount,
  hasMoreChats,
  canShowLessChats,
  worktreeParents,
  sessionMeta,
  labels,
  renderProjectEntry,
  renderSessionRow,
  startNewChat,
  closeMobileSidebar,
  setVisibleChatCount,
  handleAddProject,
  reorderVisibleProjects,
}: {
  pinnedEntries: PinnedEntry[];
  filteredChatSessions: Session[];
  visibleChatSessions: Session[];
  filteredProjectEntries: ProjectEntryTuple[];
  hasActiveSearch: boolean;
  detachedProject?: string;
  defaultChatDirectory?: string | null;
  visibleChatCount: number;
  hasMoreChats: boolean;
  canShowLessChats: boolean;
  worktreeParents: WorktreeParentMap;
  sessionMeta: SessionMetaMap;
  labels: {
    pinned: string;
    chats: string;
    projects: string;
    noMatches: string;
    noChats: string;
    loadMore: (count: number) => string;
    showLess: string;
    allProjectsPinned: string;
    noProjectsYet: string;
  };
  renderProjectEntry: (
    directory: string,
    sessions: Session[],
    options?: { canDrag?: boolean; dragHandleProps?: Record<string, unknown> },
  ) => ReactNode;
  renderSessionRow: (
    session: Session,
    directory: string,
    options?: { currentProjectDir?: string | null },
  ) => ReactNode;
  startNewChat: () => void | Promise<void>;
  closeMobileSidebar: () => void;
  setVisibleChatCount: React.Dispatch<React.SetStateAction<number>>;
  handleAddProject: () => void | Promise<void>;
  reorderVisibleProjects: (directories: string[]) => void;
}) {
  const sortableProjectDirectories = filteredProjectEntries.map(([directory]) => directory);
  const canReorderProjects =
    !detachedProject && !hasActiveSearch && sortableProjectDirectories.length > 1;
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleProjectDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sortableProjectDirectories.indexOf(String(active.id));
    const newIndex = sortableProjectDirectories.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    reorderVisibleProjects(arrayMove(sortableProjectDirectories, oldIndex, newIndex));
  };

  return (
    <>
      {pinnedEntries.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel className="!text-sm">{labels.pinned}</SidebarGroupLabel>
          <SidebarGroupContent>
            {pinnedEntries.map((entry) =>
              entry.kind === "project"
                ? renderProjectEntry(entry.directory, entry.sessions)
                : renderSessionRow(entry.session, entry.projectDirectory, {
                    currentProjectDir: entry.projectDirectory,
                  }),
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      )}
      {!detachedProject && defaultChatDirectory && (
        <SidebarGroup>
          <SidebarGroupLabel className="group/label flex items-center justify-between !text-sm">
            <span>{labels.chats}</span>
            <button
              type="button"
              onClick={() => {
                void startNewChat();
                closeMobileSidebar();
              }}
              disabled={!defaultChatDirectory}
              className="opacity-0 group-hover/label:opacity-100 transition-opacity h-6 w-6 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground"
            >
              <SquarePen className="h-4 w-4" />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {filteredChatSessions.length === 0 ? (
              hasActiveSearch &&
              filteredProjectEntries.length === 0 &&
              pinnedEntries.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">{labels.noMatches}</div>
              ) : (
                <div className="px-2 py-1 text-[11px] text-muted-foreground">{labels.noChats}</div>
              )
            ) : (
              <SidebarMenu>
                {visibleChatSessions.map((session) =>
                  renderSessionRow(
                    session,
                    getSessionPlacementInfo(
                      session,
                      worktreeParents,
                      sessionMeta[session.id]?.assignedProjectDir ?? null,
                    )?.displayDirectory ?? getSessionExecutionDirectory(session),
                    { currentProjectDir: null },
                  ),
                )}
                {hasMoreChats && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setVisibleChatCount((prev) => prev + SESSION_PAGE_SIZE)}
                      className="text-muted-foreground min-w-0"
                    >
                      <ChevronDown className="shrink-0" />
                      <span className="truncate">
                        {labels.loadMore(filteredChatSessions.length - visibleChatCount)}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {canShowLessChats && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setVisibleChatCount(SESSION_PAGE_SIZE)}
                      className="text-muted-foreground min-w-0"
                    >
                      <ChevronUp className="shrink-0" />
                      <span className="truncate">{labels.showLess}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      )}
      <SidebarGroup>
        <SidebarGroupLabel className="group/label flex items-center justify-between !text-sm">
          {labels.projects}
          <button
            type="button"
            onClick={() => void handleAddProject()}
            className="opacity-0 group-hover/label:opacity-100 transition-opacity h-6 w-6 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
          </button>
        </SidebarGroupLabel>
        <SidebarGroupContent>
          {filteredProjectEntries.length === 0 ? (
            hasActiveSearch && pinnedEntries.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">{labels.noMatches}</div>
            ) : pinnedEntries.length > 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                {labels.allProjectsPinned}
              </div>
            ) : (
              <div className="px-2 py-3 text-sm text-muted-foreground">{labels.noProjectsYet}</div>
            )
          ) : canReorderProjects ? (
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleProjectDragEnd}
            >
              <SortableContext
                items={sortableProjectDirectories}
                strategy={verticalListSortingStrategy}
              >
                {filteredProjectEntries.map(([directory, dirSessions]) => (
                  <SortableProjectFrame key={directory} directory={directory}>
                    {({ dragHandleProps }) =>
                      renderProjectEntry(directory, dirSessions, { canDrag: true, dragHandleProps })
                    }
                  </SortableProjectFrame>
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            filteredProjectEntries.map(([directory, dirSessions]) =>
              renderProjectEntry(directory, dirSessions),
            )
          )}
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}
