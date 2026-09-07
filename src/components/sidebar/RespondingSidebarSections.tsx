import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import type { Session } from "@/hooks/agent-state-types";
import { SESSION_PAGE_SIZE } from "@/lib/constants";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export function RespondingSidebarSections({
  respondingSessions,
  workingSessions,
  idleSessions,
  totalSessionCount,
  visibleSessionCount,
  hasActiveSearch,
  isMessageSearchPending,
  labels,
  renderSessionRow,
  setVisibleSessionCount,
}: {
  respondingSessions: Session[];
  workingSessions: Session[];
  idleSessions: Session[];
  totalSessionCount: number;
  visibleSessionCount: number;
  hasActiveSearch: boolean;
  isMessageSearchPending: boolean;
  labels: {
    responding: string;
    working: string;
    chats: string;
    noMatches: string;
    noChats: string;
    loadMore: (count: number) => string;
    showLess: string;
  };
  renderSessionRow: (
    session: Session,
    directory: string,
    options?: { currentProjectDir?: string | null; showProjectLabel?: boolean },
  ) => ReactNode;
  setVisibleSessionCount: React.Dispatch<React.SetStateAction<number>>;
}) {
  const shownCount = respondingSessions.length + workingSessions.length + idleSessions.length;
  const hasMore = totalSessionCount > shownCount;
  const groups = [
    { label: labels.responding, sessions: respondingSessions },
    { label: labels.working, sessions: workingSessions },
    { label: labels.chats, sessions: idleSessions },
  ];

  if (shownCount === 0) {
    if (isMessageSearchPending) return null;
    return (
      <div className="px-4 py-5 text-sm text-muted-foreground group-data-[collapsible=icon]:hidden">
        {hasActiveSearch ? labels.noMatches : labels.noChats}
      </div>
    );
  }

  return (
    <>
      {groups.map(({ label, sessions }) =>
        sessions.length > 0 ? (
          <SidebarGroup key={label} className="pb-0">
            <SidebarGroupLabel className="!text-sm">{label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {sessions.map((session) => {
                  const directory = session._projectDir ?? session.directory ?? "";
                  return renderSessionRow(session, directory, {
                    currentProjectDir: directory,
                    showProjectLabel: true,
                  });
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null,
      )}
      {(hasMore || visibleSessionCount > SESSION_PAGE_SIZE) && (
        <SidebarGroup className="pt-1">
          <SidebarMenu>
            {hasMore && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => setVisibleSessionCount((count) => count + SESSION_PAGE_SIZE)}
                  className="text-muted-foreground"
                >
                  <ChevronDown />
                  <span>{labels.loadMore(totalSessionCount - shownCount)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {visibleSessionCount > SESSION_PAGE_SIZE && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => setVisibleSessionCount(SESSION_PAGE_SIZE)}
                  className="text-muted-foreground"
                >
                  <ChevronUp />
                  <span>{labels.showLess}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>
      )}
    </>
  );
}
