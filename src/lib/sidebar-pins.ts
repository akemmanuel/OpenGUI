import {
  getSessionPlacementInfo,
  type WorktreePlacementMap,
  type WorktreePlacementSessionLike,
} from "@/lib/worktree-placement";
import { getSidebarProjectMeta } from "@/lib/sidebar-project-meta";
import { normalizeProjectPath } from "@/lib/utils";

interface SidebarPinMetaLike {
  pinnedAt?: string | null;
  displayProjectDir?: string | null;
}

interface SidebarPinSessionLike extends WorktreePlacementSessionLike {
  id: string;
}

type SidebarProjectEntry<TSession> = [string, TSession[]];

type SidebarPinnedEntry<TSession> =
  | {
      kind: "project";
      directory: string;
      sessions: TSession[];
      pinnedAt: string;
    }
  | {
      kind: "session";
      session: TSession;
      projectDirectory: string;
      pinnedAt: string;
    };

interface SidebarPinPartitionResult<TSession> {
  pinnedEntries: SidebarPinnedEntry<TSession>[];
  projectEntries: Array<SidebarProjectEntry<TSession>>;
  projectSessionsByDirectory: Record<string, TSession[]>;
}

function getPinnedAt(meta?: SidebarPinMetaLike): string | null {
  return typeof meta?.pinnedAt === "string" && meta.pinnedAt ? meta.pinnedAt : null;
}

export function getSidebarSessionProjectDirectory<TSession extends SidebarPinSessionLike>(
  session: TSession,
  worktreeParents: WorktreePlacementMap,
): string {
  return (
    getSessionPlacementInfo(session, worktreeParents)?.displayDirectory ??
    normalizeProjectPath(session._projectDir ?? session.directory)
  );
}

export function partitionSidebarPins<TSession extends SidebarPinSessionLike>({
  projectEntries,
  sessionMeta,
  projectMeta,
  workspaceId,
  worktreeParents,
}: {
  projectEntries: Array<SidebarProjectEntry<TSession>>;
  sessionMeta: Record<string, SidebarPinMetaLike | undefined>;
  projectMeta: Record<string, SidebarPinMetaLike | undefined>;
  workspaceId?: string | null;
  worktreeParents: WorktreePlacementMap;
}): SidebarPinPartitionResult<TSession> {
  const pinnedProjectDirectories = new Set<string>();
  const pinnedEntries: SidebarPinnedEntry<TSession>[] = [];
  const projectSessionsByDirectory: Record<string, TSession[]> = {};

  for (const [directory, sessions] of projectEntries) {
    const normalizedDirectory = normalizeProjectPath(directory);
    const pinnedAt = getPinnedAt(
      getSidebarProjectMeta(projectMeta, workspaceId, normalizedDirectory) ??
        projectMeta[normalizedDirectory],
    );
    if (pinnedAt) {
      pinnedProjectDirectories.add(normalizedDirectory);
      pinnedEntries.push({
        kind: "project",
        directory: normalizedDirectory,
        sessions,
        pinnedAt,
      });
      projectSessionsByDirectory[normalizedDirectory] = sessions;
      continue;
    }

    projectSessionsByDirectory[normalizedDirectory] = sessions.filter(
      (session) => !getPinnedAt(sessionMeta[session.id]),
    );
  }

  for (const [, sessions] of projectEntries) {
    for (const session of sessions) {
      const pinnedAt = getPinnedAt(sessionMeta[session.id]);
      if (!pinnedAt) continue;
      const displayProjectDir = normalizeProjectPath(
        sessionMeta[session.id]?.displayProjectDir ?? "",
      );
      const projectDirectory =
        displayProjectDir || getSidebarSessionProjectDirectory(session, worktreeParents);
      if (pinnedProjectDirectories.has(projectDirectory)) continue;
      pinnedEntries.push({
        kind: "session",
        session,
        projectDirectory,
        pinnedAt,
      });
    }
  }

  const nextProjectEntries = projectEntries
    .filter(([directory]) => !pinnedProjectDirectories.has(normalizeProjectPath(directory)))
    .map(([directory]) => {
      const normalizedDirectory = normalizeProjectPath(directory);
      return [
        normalizedDirectory,
        projectSessionsByDirectory[normalizedDirectory] ?? [],
      ] satisfies SidebarProjectEntry<TSession>;
    });

  pinnedEntries.sort((a, b) => {
    if (a.pinnedAt !== b.pinnedAt) return a.pinnedAt.localeCompare(b.pinnedAt);
    if (a.kind !== b.kind) return a.kind === "project" ? -1 : 1;
    return 0;
  });

  return {
    pinnedEntries,
    projectEntries: nextProjectEntries,
    projectSessionsByDirectory,
  };
}
