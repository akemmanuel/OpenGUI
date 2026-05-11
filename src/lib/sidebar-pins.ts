import { normalizeProjectPath } from "@/lib/utils";

interface SidebarPinMetaLike {
  pinnedAt?: string | null;
  assignedProjectDir?: string | null;
}

interface SidebarPinSessionLike {
  id: string;
  directory: string;
  _projectDir?: string;
}

interface SidebarWorktreeParentLike {
  parentDir: string;
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
  worktreeParents: Record<string, SidebarWorktreeParentLike | undefined>,
): string {
  const sessionDirectory = normalizeProjectPath(session._projectDir ?? session.directory);
  return normalizeProjectPath(worktreeParents[sessionDirectory]?.parentDir ?? sessionDirectory);
}

export function partitionSidebarPins<TSession extends SidebarPinSessionLike>({
  projectEntries,
  sessionMeta,
  projectMeta,
  worktreeParents,
}: {
  projectEntries: Array<SidebarProjectEntry<TSession>>;
  sessionMeta: Record<string, SidebarPinMetaLike | undefined>;
  projectMeta: Record<string, SidebarPinMetaLike | undefined>;
  worktreeParents: Record<string, SidebarWorktreeParentLike | undefined>;
}): SidebarPinPartitionResult<TSession> {
  const pinnedProjectDirectories = new Set<string>();
  const pinnedEntries: SidebarPinnedEntry<TSession>[] = [];
  const projectSessionsByDirectory: Record<string, TSession[]> = {};

  for (const [directory, sessions] of projectEntries) {
    const normalizedDirectory = normalizeProjectPath(directory);
    const pinnedAt = getPinnedAt(projectMeta[normalizedDirectory]);
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
      const assignedProjectDir = normalizeProjectPath(
        sessionMeta[session.id]?.assignedProjectDir ?? "",
      );
      const projectDirectory =
        assignedProjectDir || getSidebarSessionProjectDirectory(session, worktreeParents);
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
