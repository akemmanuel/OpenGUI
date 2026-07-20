import { useCallback, useMemo } from "react";
import type { Session } from "@/hooks/agent-state-types";
import type { ProjectMetaMap, SessionMetaMap } from "@/lib/persistence";
import { partitionSidebarPins } from "@/lib/persistence/sidebar-pins";
import { getProjectName, normalizeProjectPath } from "@/lib/path";
import type { ConnectionStatus } from "@/types/connection";
import type { Workspace } from "@/types/workspace";
import { parseProjectKey } from "@/hooks/agent-session-utils";
import { getSessionExecutionDirectory } from "@/hooks/agent-session-utils";
import { isSidebarProjectHidden } from "@/lib/persistence/project";
import { buildSidebarOrderedRootProjectDirectories } from "@/lib/sidebar-project-entries";

function getSidebarSessionSortTime(session: Session, sessionMeta: SessionMetaMap) {
  const meta = sessionMeta[session.id];
  if (typeof meta?.sidebarMovedAt === "number") {
    return meta.sidebarMovedAt;
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
  if (meta?.sidebarSection) return meta.sidebarSection === "chats";
  return isDefaultChatDirectory(session._projectDir ?? session.directory);
}

export function shouldKeepSessionOutOfProjectGroups({
  session,
  meta,
  displayProjectDir,
  isDefaultChatDirectory,
}: {
  session: Session;
  meta: SessionMetaMap[string] | undefined;
  displayProjectDir: string;
  isDefaultChatDirectory: (directory?: string | null) => boolean;
}) {
  if (meta?.sidebarSection) return meta.sidebarSection === "chats";
  return !displayProjectDir && isDefaultChatDirectory(session._projectDir ?? session.directory);
}

export function sortSessionsForSidebar(items: Session[], sessionMeta: SessionMetaMap) {
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
        (directory) => !isSidebarProjectHidden(projectMeta, activeWorkspace?.id, directory),
      ),
    [activeWorkspace?.id, activeWorkspace?.projects, projectMeta],
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
    (items: Session[]) => sortSessionsForSidebar(items, sessionMeta),
    [sessionMeta],
  );

  const projectGroups = useMemo(() => {
    const visibleProjectDirectorySet = new Set(
      (detachedProject ? [detachedProject] : availableProjectDirectories)
        .map((dir) => normalizeProjectPath(dir))
        .filter(Boolean),
    );
    const openDirectories = Object.entries(connections)
      .filter(([, status]) => status.state === "connected")
      .map(([projectKey]) => normalizeProjectPath(parseProjectKey(projectKey).directory))
      .filter((dir): dir is string => Boolean(dir) && visibleProjectDirectorySet.has(dir));
    const rootOpenDirectories = openDirectories;
    const workspaceProjects = (activeWorkspace?.projects ?? [])
      .map((dir) => normalizeProjectPath(dir))
      .filter(Boolean);
    const projectDirectorySet = new Set([
      ...rootOpenDirectories,
      ...workspaceProjects,
      ...visibleProjectDirectorySet,
    ]);
    const normalizedDetachedProject = normalizeProjectPath(detachedProject ?? "");
    const orderedRootDirectories = buildSidebarOrderedRootProjectDirectories({
      availableProjectDirectories,
      connectedRootDirectories: rootOpenDirectories,
      detachedProject: normalizedDetachedProject || undefined,
    });
    const groups = new Map<string, Session[]>();
    for (const dir of orderedRootDirectories) groups.set(dir, []);

    for (const session of sessions) {
      const meta = sessionMeta[session.id];
      if (session.parentID || meta?.movedToSessionId) {
        continue;
      }
      const displayProjectDir = normalizeProjectPath(meta?.displayProjectDir ?? "");
      if (
        shouldKeepSessionOutOfProjectGroups({
          session,
          meta,
          displayProjectDir,
          isDefaultChatDirectory,
        })
      ) {
        continue;
      }
      const effectiveDisplayProjectDir =
        displayProjectDir && projectDirectorySet.has(displayProjectDir) ? displayProjectDir : null;
      const executionDirectory = normalizeProjectPath(getSessionExecutionDirectory(session) ?? "");
      const displayDirectory = effectiveDisplayProjectDir ?? executionDirectory;
      if (!displayDirectory || !visibleProjectDirectorySet.has(displayDirectory)) continue;
      if (
        normalizedDetachedProject &&
        displayDirectory !== normalizedDetachedProject &&
        executionDirectory !== normalizedDetachedProject
      ) {
        continue;
      }
      if (!groups.has(displayDirectory)) groups.set(displayDirectory, []);
      groups.get(displayDirectory)?.push(session);
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
    detachedProject,
    activeWorkspace,
    availableProjectDirectories,
    sessionMeta,
    sortSidebarSessions,
  ]);

  const showChatsSection = useMemo(
    () => Boolean(normalizeProjectPath(defaultChatDirectory ?? "")),
    [defaultChatDirectory],
  );

  const chatSessions = useMemo(
    () =>
      showChatsSection
        ? sortSidebarSessions(
            sessions.filter((session) =>
              shouldShowSessionInChatList({
                session,
                meta: sessionMeta[session.id],
                isDefaultChatDirectory,
              }),
            ),
          )
        : [],
    [sessions, isDefaultChatDirectory, sessionMeta, showChatsSection, sortSidebarSessions],
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
        workspaceId: activeWorkspace?.id,
      }),
    [activeWorkspace?.id, projectMeta, searchFilteredProjectEntries, sessionMeta],
  );

  return {
    normalizedSearchQuery,
    hasActiveSearch,
    availableProjectDirectories,
    projectGroups,
    filteredChatSessions,
    showChatsSection,
    ...pinnedModel,
  };
}
