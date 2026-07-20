import { useCallback, useEffect, useState } from "react";
import {
  getSidebarCollapsedProjects,
  persistSidebarCollapsedProjects,
  pruneSidebarCollapsedProjects,
  toggleSidebarProjectCollapsed,
} from "@/lib/persistence/sidebar";

export function useSidebarCollapsedProjects({
  activeWorkspaceProjectDirectories,
  detachedProject,
  hydrationReady,
  openDirectories,
}: {
  activeWorkspaceProjectDirectories: string[];
  detachedProject?: string;
  hydrationReady: boolean;
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
    // workspace project list when available, merge it with connected directories, and
    // never let detached windows or not-yet-ready hydration prune shared sidebar state.
    if (detachedProject) return;
    if (!hydrationReady) return;
    const collapsedPruneDirectories = Array.from(
      new Set([...activeWorkspaceProjectDirectories, ...openDirectories]),
    );
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
  }, [activeWorkspaceProjectDirectories, detachedProject, hydrationReady, openDirectories]);

  useEffect(() => {
    persistSidebarCollapsedProjects(collapsed);
  }, [collapsed]);

  return { collapsed, toggleCollapsed, revealCollapsedProject };
}
