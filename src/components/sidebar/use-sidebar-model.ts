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

export function useSidebarModel({
  sessions,
  sessionMeta,
  projectMeta,
  worktreeParents,
  activeWorkspace,
  connections,
  detachedProject,
  defaultChatDirectory,
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

  const sortSessionsForSidebar = useCallback(
    (items: Session[]) =>
      [...items].sort((a, b) => {
        const aMeta = sessionMeta[a.id];
        const bMeta = sessionMeta[b.id];
        const aTime =
          aMeta?.assignedProjectDir && typeof aMeta.assignedProjectMovedAt === "number"
            ? aMeta.assignedProjectMovedAt
            : (a.time.updated ?? a.time.created ?? 0);
        const bTime =
          bMeta?.assignedProjectDir && typeof bMeta.assignedProjectMovedAt === "number"
            ? bMeta.assignedProjectMovedAt
            : (b.time.updated ?? b.time.created ?? 0);
        const byUpdated = bTime - aTime;
        if (byUpdated !== 0) return byUpdated;
        return b.id.localeCompare(a.id);
      }),
    [sessionMeta],
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
    const projectDirectorySet = new Set([...rootOpenDirectories, ...visibleProjectDirectorySet]);
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
      if (session.parentID || sessionMeta[session.id]?.movedToSessionId) continue;
      const assignedProjectDir = normalizeProjectPath(
        sessionMeta[session.id]?.assignedProjectDir ?? "",
      );
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
        sortSessionsForSidebar(dirSessions),
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
    sortSessionsForSidebar,
  ]);

  const chatSessions = useMemo(
    () =>
      sortSessionsForSidebar(
        sessions.filter(
          (session) =>
            !session.parentID &&
            !sessionMeta[session.id]?.movedToSessionId &&
            isDefaultChatDirectory(session._projectDir ?? session.directory),
        ),
      ),
    [sessions, isDefaultChatDirectory, sessionMeta, sortSessionsForSidebar],
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
