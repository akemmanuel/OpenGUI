import { useCallback, useEffect, useState } from "react";
import {
  getSidebarCollapsedProjects,
  persistSidebarCollapsedProjects,
  pruneSidebarCollapsedProjects,
  toggleSidebarProjectCollapsed,
} from "@/lib/sidebar-collapsed";

export function useSidebarCollapsedProjects({
  activeWorkspaceProjectDirectories,
  detachedProject,
  openDirectories,
}: {
  activeWorkspaceProjectDirectories: string[];
  detachedProject?: string;
  openDirectories: string[];
}) {
  const [collapsed, setCollapsed] = useState(() => getSidebarCollapsedProjects());
  const toggleCollapsed = useCallback((dir: string) => {
    setCollapsed((prev) => toggleSidebarProjectCollapsed(prev, dir));
  }, []);
  const revealCollapsedProject = useCallback((directory: string) => {
    setCollapsed((prev) => {
      if (!prev[directory]) return prev;
      const { [directory]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  useEffect(() => {
    // Keep collapsed project state across app startup. Connections hydrate after
    // frontend-persisted state, so pruning against an empty/partial connection list can
    // delete saved collapsed projects before they reconnect. Use persisted
    // workspace project list when available, and never let detached windows prune
    // shared sidebar state for other projects.
    if (detachedProject) return;
    const collapsedPruneDirectories =
      activeWorkspaceProjectDirectories.length > 0
        ? activeWorkspaceProjectDirectories
        : openDirectories;
    if (collapsedPruneDirectories.length === 0) return;

    setCollapsed((prev) => {
      const next = pruneSidebarCollapsedProjects(prev, collapsedPruneDirectories);
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length === nextKeys.length && nextKeys.every((directory) => prev[directory])) {
        return prev;
      }
      return next;
    });
  }, [activeWorkspaceProjectDirectories, detachedProject, openDirectories]);

  useEffect(() => {
    persistSidebarCollapsedProjects(collapsed);
  }, [collapsed]);

  return { collapsed, toggleCollapsed, revealCollapsedProject };
}
