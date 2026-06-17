import { useCallback, useMemo } from "react";
import type { Session } from "@/hooks/agent-state-types";
import type {
  ProjectMetaMap,
  SessionMetaMap,
  WorktreeParentMap,
} from "@/hooks/agent-state-persistence";
import { partitionSidebarPins } from "@/lib/sidebar-pins";
import {
  getSessionPlacementInfo,
  shouldHideTopLevelProjectDirectory,
  shouldShowSessionInProjectList,
} from "@/lib/worktree-placement";
import { getProjectName, normalizeProjectPath } from "@/lib/utils";
import type { ConnectionStatus, Workspace } from "@/types/electron";
import { parseProjectKey } from "@/hooks/agent-session-utils";
import type { HarnessId } from "@/agents";

function getSidebarSessionSortTime(session: Session, sessionMeta: SessionMetaMap) {
  const meta = sessionMeta[session.id];
  if (meta?.detachedFromProject && typeof meta.detachedFromProjectAt === "number") {
    return meta.detachedFromProjectAt;
  }
  if (meta?.assignedProjectDir && typeof meta.assignedProjectMovedAt === "number") {
    return meta.assignedProjectMovedAt;
  }
  return session.time?.updated ?? session.time?.created ?? 0;
}

export function shouldShowSessionInChatList({
  session,
  meta,
  isDefaultChatDirectory,
}: {
  session: Session;
  meta: SessionMetaMap[string] | undefined;
  isDefaultChatDirectory: (directory?: string | null) => boolean;
}) {
  if (session.parentID || meta?.movedToSessionId) return false;
  if (meta?.detachedFromProject === true) return true;
  if (meta?.originMode === "project") return false;
  if (normalizeProjectPath(meta?.assignedProjectDir ?? "")) return false;
  return isDefaultChatDirectory(session._projectDir ?? session.directory);
}

export function sortSessionsForSidebar(
  items: Session[],
  sessionMeta: SessionMetaMap,
  _preferredHarnessId?: HarnessId | null,
) {
  return [...items].sort((a, b) => {
    const byUpdated =
      getSidebarSessionSortTime(b, sessionMeta) - getSidebarSessionSortTime(a, sessionMeta);
    if (byUpdated !== 0) return byUpdated;
    return b.id.localeCompare(a.id);
  });
}

export function useSidebarModel({
  sessions,
  sessionMeta,
  projectMeta,
  worktreeParents,
  activeWorkspace,
  connections,
  detachedProject,
  defaultChatDirectory,
  preferredHarnessId,
  searchQuery,
  untitledLabel,
}: {
  sessions: Session[];
  sessionMeta: SessionMetaMap;
  projectMeta: ProjectMetaMap;
  worktreeParents: WorktreeParentMap;
  activeWorkspace: Workspace | null | undefined;
  connections: Record<string, ConnectionStatus>;
  detachedProject?: string;
  defaultChatDirectory?: string | null;
  preferredHarnessId?: HarnessId | null;
  searchQuery: string;
  untitledLabel: string;
}) {
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const hasActiveSearch = normalizedSearchQuery.length > 0;

  const availableProjectDirectories = useMemo(
    () =>
      (activeWorkspace?.projects ?? []).filter(
        (directory) => projectMeta[normalizeProjectPath(directory)]?.hidden !== true,
      ),
    [activeWorkspace?.projects, projectMeta],
  );

  const isDefaultChatDirectory = useCallback(
    (directory?: string | null) => {
      const normalizedDirectory = normalizeProjectPath(directory ?? "");
      const normalizedDefaultChatDirectory = normalizeProjectPath(defaultChatDirectory ?? "");
      return Boolean(
        normalizedDirectory &&
        normalizedDefaultChatDirectory &&
        normalizedDirectory === normalizedDefaultChatDirectory,
      );
    },
    [defaultChatDirectory],
  );

  const sortSidebarSessions = useCallback(
    (items: Session[]) => sortSessionsForSidebar(items, sessionMeta, preferredHarnessId),
    [preferredHarnessId, sessionMeta],
  );

  const projectGroups = useMemo(() => {
    const visibleProjectDirectorySet = new Set(
      (detachedProject ? [detachedProject] : availableProjectDirectories)
        .map((dir) => normalizeProjectPath(dir))
        .filter(Boolean),
    );
    const openDirectories = Object.entries(connections)
      .filter(([, status]) => status.state === "connected" && status.kind !== "chat-infra")
      .map(([projectKey]) => normalizeProjectPath(parseProjectKey(projectKey).directory))
      .filter((dir): dir is string => Boolean(dir) && visibleProjectDirectorySet.has(dir));
    const rootOpenDirectories = openDirectories.filter(
      (dir) => !shouldHideTopLevelProjectDirectory(dir, worktreeParents),
    );
    const workspaceProjects = (activeWorkspace?.projects ?? [])
      .map((dir) => normalizeProjectPath(dir))
      .filter(Boolean);
    const projectDirectorySet = new Set([
      ...rootOpenDirectories,
      ...workspaceProjects,
      ...visibleProjectDirectorySet,
    ]);
    const normalizedDetachedProject = normalizeProjectPath(detachedProject ?? "");
    const orderedRootDirectories = detachedProject
      ? rootOpenDirectories.filter((dir) => dir === normalizedDetachedProject)
      : [
          ...availableProjectDirectories
            .map((dir) => normalizeProjectPath(dir))
            .filter((dir) => rootOpenDirectories.includes(dir)),
          ...rootOpenDirectories.filter(
            (dir) =>
              !availableProjectDirectories
                .map((projectDir) => normalizeProjectPath(projectDir))
                .includes(dir),
          ),
        ];
    const groups = new Map<string, Session[]>();
    for (const dir of orderedRootDirectories) groups.set(dir, []);

    for (const session of sessions) {
      const meta = sessionMeta[session.id];
      if (session.parentID || meta?.movedToSessionId || meta?.detachedFromProject === true) {
        continue;
      }
      const assignedProjectDir = normalizeProjectPath(meta?.assignedProjectDir ?? "");
      const effectiveAssignedProjectDir =
        assignedProjectDir && projectDirectorySet.has(assignedProjectDir)
          ? assignedProjectDir
          : null;
      if (
        !shouldShowSessionInProjectList(session, {
          worktreeParents,
          visibleProjectDirectories: visibleProjectDirectorySet,
          assignedProjectDir: effectiveAssignedProjectDir,
        })
      ) {
        continue;
      }
      const placement = getSessionPlacementInfo(
        session,
        worktreeParents,
        effectiveAssignedProjectDir,
      );
      if (!placement) continue;
      if (
        normalizedDetachedProject &&
        placement.displayDirectory !== normalizedDetachedProject &&
        placement.executionDirectory !== normalizedDetachedProject
      ) {
        continue;
      }
      if (!groups.has(placement.displayDirectory)) groups.set(placement.displayDirectory, []);
      groups.get(placement.displayDirectory)?.push(session);
    }

    return new Map(
      Array.from(groups, ([directory, dirSessions]) => [
        directory,
        sortSidebarSessions(dirSessions),
      ]),
    );
  }, [
    sessions,
    connections,
    worktreeParents,
    detachedProject,
    activeWorkspace,
    availableProjectDirectories,
    sessionMeta,
    sortSidebarSessions,
  ]);

  const chatSessions = useMemo(
    () =>
      sortSidebarSessions(
        sessions.filter((session) =>
          shouldShowSessionInChatList({
            session,
            meta: sessionMeta[session.id],
            isDefaultChatDirectory,
          }),
        ),
      ),
    [sessions, isDefaultChatDirectory, sessionMeta, sortSidebarSessions],
  );

  const filteredChatSessions = useMemo(() => {
    if (!hasActiveSearch) return chatSessions;
    return chatSessions.filter((session) => {
      const sessionTags = sessionMeta[session.id]?.tags ?? [];
      const sessionSearchText =
        `${session.title || untitledLabel} ${sessionTags.join(" ")}`.toLowerCase();
      return sessionSearchText.includes(normalizedSearchQuery);
    });
  }, [chatSessions, hasActiveSearch, normalizedSearchQuery, sessionMeta, untitledLabel]);

  const projectEntries = useMemo(() => Array.from(projectGroups), [projectGroups]);
  const searchFilteredProjectEntries = useMemo(() => {
    if (!hasActiveSearch) return projectEntries;

    return projectEntries
      .map(([directory, dirSessions]) => {
        const projectSearchText = `${getProjectName(directory)} ${directory}`.toLowerCase();
        if (projectSearchText.includes(normalizedSearchQuery)) {
          return [directory, dirSessions] as const;
        }

        const matchingSessions = dirSessions.filter((session) => {
          const sessionTags = sessionMeta[session.id]?.tags ?? [];
          const sessionSearchText =
            `${session.title || untitledLabel} ${sessionTags.join(" ")}`.toLowerCase();
          return sessionSearchText.includes(normalizedSearchQuery);
        });
        return matchingSessions.length > 0 ? ([directory, matchingSessions] as const) : null;
      })
      .filter((entry): entry is (typeof projectEntries)[number] => entry !== null);
  }, [hasActiveSearch, normalizedSearchQuery, projectEntries, sessionMeta, untitledLabel]);

  const pinnedModel = useMemo(
    () =>
      partitionSidebarPins({
        projectEntries: searchFilteredProjectEntries,
        sessionMeta,
        projectMeta,
        worktreeParents,
      }),
    [projectMeta, searchFilteredProjectEntries, sessionMeta, worktreeParents],
  );

  return {
    normalizedSearchQuery,
    hasActiveSearch,
    availableProjectDirectories,
    projectGroups,
    filteredChatSessions,
    ...pinnedModel,
  };
}
