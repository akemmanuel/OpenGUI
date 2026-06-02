import { CirclePlus, MessageSquare, ShieldAlert } from "lucide-react";
import type { RefObject } from "react";
import type { Session } from "@/hooks/agent-state-types";
import { getProjectName } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

export function CollapsedProjectPopover({
  popoverRef,
  directory,
  top,
  sessions,
  activeSessionId,
  busySessionIds,
  unreadSessionIds,
  queuedPrompts,
  pendingQuestions,
  pendingPermissions,
  namingSessionIds,
  untitledLabel,
  labels,
  hasUnsentDraft,
  setActiveTarget,
  selectSession,
  closePopover,
  closeMobileSidebar,
}: {
  popoverRef: RefObject<HTMLDivElement | null>;
  directory: string;
  top: number;
  sessions: Session[];
  activeSessionId: string | null;
  busySessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  queuedPrompts: Record<string, unknown[]>;
  pendingQuestions: Record<string, unknown>;
  pendingPermissions: Record<string, unknown>;
  namingSessionIds: Set<string>;
  untitledLabel: string;
  labels: {
    newSession: string;
    noSessionsYet: string;
  };
  hasUnsentDraft: (sessionId: string) => boolean;
  setActiveTarget: (directory: string) => void;
  selectSession: (sessionId: string) => void | Promise<void>;
  closePopover: () => void;
  closeMobileSidebar: () => void;
}) {
  return (
    <div
      ref={popoverRef}
      className="fixed left-[calc(var(--sidebar-width-icon)+0.125rem)] z-50 w-72 rounded-lg border border-sidebar-border bg-sidebar p-2 shadow-xl"
      style={{ top: Math.max(8, top - 8), maxHeight: "calc(100vh - 1rem)" }}
    >
      <div className="mb-1 flex items-center gap-2 px-2 py-1">
        <div className="truncate text-sm font-medium">{getProjectName(directory)}</div>
        <div className="ml-auto text-xs text-muted-foreground">{sessions.length}</div>
      </div>
      <ul className="max-h-[min(32rem,calc(100vh-5rem))] space-y-1 overflow-y-auto">
        <li>
          <button
            type="button"
            onClick={() => {
              setActiveTarget(directory);
              closePopover();
              closeMobileSidebar();
            }}
            className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm"
          >
            <CirclePlus className="size-4 shrink-0" />
            <span className="truncate">{labels.newSession}</span>
          </button>
        </li>
        {sessions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">{labels.noSessionsYet}</div>
        ) : (
          sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const isBusy = busySessionIds.has(session.id);
            const isUnread = unreadSessionIds.has(session.id);
            const hasUnsent = hasUnsentDraft(session.id);
            const queueCount = (queuedPrompts[session.id] ?? []).length;
            const hasQuestion = !!pendingQuestions[session.id];
            const hasPermission = !!pendingPermissions[session.id];
            const isNaming = namingSessionIds.has(session.id);

            return (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => {
                    void selectSession(session.id);
                    closePopover();
                    closeMobileSidebar();
                  }}
                  className={`text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm min-w-0 ${
                    isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""
                  }`}
                >
                  <span className="relative shrink-0">
                    {isBusy ? (
                      <Spinner className="text-muted-foreground" />
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
                  {isNaming ? (
                    <Skeleton className="h-4 min-w-0 flex-1 bg-sidebar-foreground/20" />
                  ) : (
                    <span className={`truncate min-w-0 flex-1 ${isUnread ? "font-semibold" : ""}`}>
                      {session.title || untitledLabel}
                    </span>
                  )}
                  {hasPermission && (
                    <span className="shrink-0 rounded-full bg-orange-500/15 text-orange-500 text-[10px] font-bold px-1.5 py-0.5">
                      <ShieldAlert className="size-3.5" />
                    </span>
                  )}
                  {hasQuestion && (
                    <span className="shrink-0 rounded-full bg-amber-500/15 text-amber-500 text-[10px] font-bold px-1.5 py-0.5">
                      ?
                    </span>
                  )}
                  {queueCount > 0 && (
                    <span className="shrink-0 rounded-full bg-primary/15 text-primary text-[10px] font-medium px-1.5 py-0.5 tabular-nums">
                      {queueCount}
                    </span>
                  )}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
