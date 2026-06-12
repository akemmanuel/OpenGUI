import { BadgeQuestionMark, GitBranch, MessageSquare, ShieldAlert } from "lucide-react";
import { HARNESS_LABELS } from "@/agents";
import type { Session } from "@/hooks/agent-state-types";
import { getSessionHarnessId } from "@/hooks/agent-session-utils";
import type {
  SessionColor,
  SessionMetaMap,
  WorktreeParentMap,
} from "@/hooks/agent-state-persistence";
import { getSessionPlacementInfo, getWorktreeLabel } from "@/lib/worktree-placement";
import { normalizeProjectPath } from "@/lib/utils";
import type { GitWorktree } from "@/types/electron";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { getColorBorderClass, SessionContextMenu } from "@/components/SessionContextMenu";
import { SessionItemMenu } from "@/components/SidebarItemMenus";
import { cleanSessionTitle } from "@/lib/session-title";

export function SessionRow({
  session,
  activeSessionId,
  busySessionIds,
  unreadSessionIds,
  queuedPrompts,
  pendingQuestions,
  pendingPermissions,
  sessionMeta,
  namingSessionIds,
  worktreeParents,
  knownWorktrees,
  availableProjectDirectories,
  editingSessionId,
  editValue,
  editInputRef,
  untitledLabel,
  hasUnsentDraft,
  selectSession,
  closeMobileSidebar,
  setEditValue,
  commitRename,
  cancelEditing,
  startEditing,
  setSessionPinned,
  setSessionColor,
  setSessionTags,
  revealSessionInProject,
  moveSessionToProject,
  deleteSession,
}: {
  session: Session;
  activeSessionId: string | null;
  busySessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  queuedPrompts: Record<string, unknown[]>;
  pendingQuestions: Record<string, unknown>;
  pendingPermissions: Record<string, unknown>;
  sessionMeta: SessionMetaMap;
  namingSessionIds: Set<string>;
  worktreeParents: WorktreeParentMap;
  knownWorktrees: Record<string, GitWorktree[]>;
  availableProjectDirectories: string[];
  editingSessionId: string | null;
  editValue: string;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  untitledLabel: string;
  hasUnsentDraft: (sessionId: string) => boolean;
  selectSession: (sessionId: string) => void | Promise<void>;
  closeMobileSidebar: () => void;
  setEditValue: (value: string) => void;
  commitRename: () => void;
  cancelEditing: () => void;
  startEditing: (sessionId: string, currentTitle: string) => void;
  setSessionPinned: (sessionId: string, pinned: boolean) => void;
  setSessionColor: (sessionId: string, color: SessionColor) => void;
  setSessionTags: (sessionId: string, tags: string[]) => void;
  revealSessionInProject: (directory: string) => void;
  moveSessionToProject: (sessionId: string, projectDirectory: string) => void | Promise<void>;
  deleteSession: (sessionId: string) => void | Promise<void>;
}) {
  const isActive = session.id === activeSessionId;
  const isBusy = busySessionIds.has(session.id);
  const isUnread = unreadSessionIds.has(session.id);
  const hasUnsent = hasUnsentDraft(session.id);
  const queueCount = (queuedPrompts[session.id] ?? []).length;
  const hasQuestion = !!pendingQuestions[session.id];
  const hasPermission = !!pendingPermissions[session.id];
  const meta = sessionMeta[session.id];
  const hasColor = !!meta?.color;
  const colorBorderClass = hasColor
    ? `border-l-[3px] -ml-[3px] ${getColorBorderClass(meta.color)}`
    : "";
  const tags = meta?.tags ?? [];
  const isPinned = !!meta?.pinnedAt;
  const isNaming = namingSessionIds.has(session.id);
  const harnessId = getSessionHarnessId(session);
  const displayTitle = cleanSessionTitle(session.title) || untitledLabel;
  const placement = getSessionPlacementInfo(
    session,
    worktreeParents,
    meta?.assignedProjectDir ?? null,
  );
  const isWorktreeSession = placement?.isKnownWorktree ?? false;
  const knownWorktree = placement?.rootDirectory
    ? (knownWorktrees[placement.rootDirectory] ?? []).find(
        (worktree) => normalizeProjectPath(worktree.path) === placement.executionDirectory,
      )
    : null;
  const worktreeBranch =
    placement && isWorktreeSession
      ? getWorktreeLabel({
          path: placement.executionDirectory,
          branch: knownWorktree?.branch ?? worktreeParents[placement.executionDirectory]?.branch,
          detached: knownWorktree?.detached,
          rootDirectory: placement.rootDirectory,
        })
      : null;

  const moveToProject = (projectDirectory: string) => {
    revealSessionInProject(projectDirectory);
    void moveSessionToProject(session.id, projectDirectory);
  };

  return (
    <SessionContextMenu
      key={session.id}
      currentColor={meta?.color}
      currentTags={tags}
      availableProjects={availableProjectDirectories}
      assignedProjectDir={meta?.assignedProjectDir ?? null}
      pinned={isPinned}
      onTogglePin={() => setSessionPinned(session.id, !isPinned)}
      onSetColor={(color) => setSessionColor(session.id, color)}
      onSetTags={(newTags) => setSessionTags(session.id, newTags)}
      onMoveToProject={moveToProject}
      onRename={() => startEditing(session.id, isNaming ? "" : session.title || "")}
      onDelete={() => deleteSession(session.id)}
    >
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          tooltip={
            isNaming
              ? undefined
              : {
                  children: displayTitle,
                  side: "right",
                  align: "center",
                  hidden: editingSessionId === session.id || isNaming,
                }
          }
          isActive={isActive}
          className={`group/session min-w-0 ${colorBorderClass}`}
        >
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (editingSessionId === session.id) return;
              void selectSession(session.id);
              closeMobileSidebar();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (editingSessionId === session.id) return;
                void selectSession(session.id);
                closeMobileSidebar();
              }
            }}
          >
            <span className="relative shrink-0">
              {isBusy ? (
                <Spinner className="size-4 text-muted-foreground" />
              ) : isWorktreeSession ? (
                <GitBranch className="size-4" />
              ) : (
                <MessageSquare className="size-4" />
              )}
              {isUnread && !isBusy && (
                <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" />
              )}
              {hasUnsent && (
                <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-amber-500 ring-1 ring-sidebar" />
              )}
            </span>
            {editingSessionId === session.id ? (
              <input
                ref={editInputRef}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEditing();
                  }
                  e.stopPropagation();
                }}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                autoFocus
                className="min-w-0 flex-1 truncate bg-transparent outline-none text-sm border-b border-primary"
              />
            ) : isNaming ? (
              <Skeleton className="h-4 min-w-0 flex-1 bg-sidebar-foreground/20" />
            ) : (
              <span
                role="textbox"
                tabIndex={-1}
                className={`truncate min-w-0 flex-1 ${isUnread ? "font-semibold" : ""}`}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startEditing(session.id, session.title || "");
                }}
              >
                {displayTitle}
              </span>
            )}
            {harnessId && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0 text-[9px] font-medium text-muted-foreground">
                {HARNESS_LABELS[harnessId]}
              </span>
            )}
            {worktreeBranch && (
              <span className="shrink-0 rounded-full bg-purple-500/15 text-purple-500 px-1.5 py-0 text-[9px] font-medium truncate max-w-[4rem]">
                {worktreeBranch}
              </span>
            )}
            {tags.length > 0 && (
              <span className="shrink-0 flex gap-0.5 overflow-hidden max-w-[4rem]">
                {tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-muted px-1.5 py-0 text-[9px] font-medium text-muted-foreground truncate max-w-[3rem]"
                  >
                    {tag}
                  </span>
                ))}
                {tags.length > 2 && (
                  <span className="text-[9px] text-muted-foreground">+{tags.length - 2}</span>
                )}
              </span>
            )}
            {hasPermission && (
              <span className="rounded-full bg-orange-500/15 text-orange-500 text-[10px] font-bold">
                <ShieldAlert className="size-4" />
              </span>
            )}
            {hasQuestion && (
              <span className="rounded-full bg-amber-500/15 text-amber-500 text-[10px] font-bold">
                <BadgeQuestionMark className="size-4" />
              </span>
            )}
            {queueCount > 0 && (
              <span className="shrink-0 rounded-full bg-primary/15 text-primary text-[10px] font-medium px-1.5 py-0.5 tabular-nums">
                {queueCount}
              </span>
            )}
            <SessionItemMenu
              pinned={isPinned}
              currentColor={meta?.color}
              currentTags={tags}
              availableProjects={availableProjectDirectories}
              assignedProjectDir={meta?.assignedProjectDir ?? null}
              onTogglePin={() => setSessionPinned(session.id, !isPinned)}
              onSetColor={(color) => setSessionColor(session.id, color)}
              onSetTags={(newTags) => setSessionTags(session.id, newTags)}
              onMoveToProject={moveToProject}
              onRename={() => startEditing(session.id, session.title || "")}
              onDelete={() => deleteSession(session.id)}
            />
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SessionContextMenu>
  );
}
