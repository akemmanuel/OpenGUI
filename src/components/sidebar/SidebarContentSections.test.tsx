// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { SidebarContentSections } from "./SidebarContentSections";

const labels = {
  pinned: "Pinned",
  chats: "Chats",
  projects: "Projects",
  newChat: "New chat",
  addProject: "Add project",
  noMatches: "No results found",
  noChats: "No chats",
  loadMore: (count: number) => `Load ${count}`,
  showLess: "Show less",
  allProjectsPinned: "All pinned",
  noProjectsYet: "No projects",
  needWorkspaceBeforeProjects: "Workspace required",
  addWorkspace: "Add workspace",
};

function renderSections(isMessageSearchPending: boolean) {
  return render(
    <SidebarContentSections
      pinnedEntries={[]}
      filteredChatSessions={[]}
      visibleChatSessions={[]}
      filteredProjectEntries={[]}
      hasActiveSearch
      isMessageSearchPending={isMessageSearchPending}
      showChatsSection={false}
      visibleChatCount={0}
      hasMoreChats={false}
      canShowLessChats={false}
      labels={labels}
      renderProjectEntry={() => null}
      renderSessionRow={() => null}
      startNewChat={vi.fn()}
      closeMobileSidebar={vi.fn()}
      setVisibleChatCount={vi.fn()}
      handleAddProject={vi.fn()}
      reorderVisibleProjects={vi.fn()}
      canManageProjects
      onAddWorkspace={vi.fn()}
    />,
  );
}

describe("SidebarContentSections search feedback", () => {
  test("waits for message search to settle before showing no results", () => {
    const view = renderSections(true);
    expect(screen.queryByText("No results found")).toBeNull();

    view.rerender(
      <SidebarContentSections
        pinnedEntries={[]}
        filteredChatSessions={[]}
        visibleChatSessions={[]}
        filteredProjectEntries={[]}
        hasActiveSearch
        isMessageSearchPending={false}
        showChatsSection={false}
        visibleChatCount={0}
        hasMoreChats={false}
        canShowLessChats={false}
        labels={labels}
        renderProjectEntry={() => null}
        renderSessionRow={() => null}
        startNewChat={vi.fn()}
        closeMobileSidebar={vi.fn()}
        setVisibleChatCount={vi.fn()}
        handleAddProject={vi.fn()}
        reorderVisibleProjects={vi.fn()}
        canManageProjects
        onAddWorkspace={vi.fn()}
      />,
    );

    expect(screen.getByText("No results found")).toBeTruthy();
  });
});
