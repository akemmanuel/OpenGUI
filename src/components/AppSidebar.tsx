import {
  BadgeQuestionMark,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CirclePlus,
  FolderOpen,
  GripVertical,
  GitBranch,
  MessageSquare,
  Plus,
  Search,
  ShieldAlert,
  SquarePen,
  X,
} from "lucide-react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ContextMenu } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AGENT_BACKEND_LABELS } from "@/agents";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHomeDir } from "@/hooks/use-home-dir";
import { useActions, useConnectionState, useSessionState } from "@/hooks/use-agent-state";
import { useOutsideClick } from "@/hooks/use-outside-click";
import { POST_MERGE_DELAY_MS, SESSION_PAGE_SIZE } from "@/lib/constants";
import {
  getSidebarCollapsedProjects,
  isSidebarProjectCollapsed,
  persistSidebarCollapsedProjects,
  pruneSidebarCollapsedProjects,
  toggleSidebarProjectCollapsed,
  type SidebarCollapsedProjects,
} from "@/lib/sidebar-collapsed";
import { partitionSidebarPins } from "@/lib/sidebar-pins";
import {
  abbreviatePath,
  buildPRUrl,
  getProjectName,
  normalizeProjectPath,
  openExternalLink,
  pruneRecord,
} from "@/lib/utils";
import type { GitWorktree } from "@/types/electron";
import logoDark from "../../opencode-logo-dark.svg";
import logoLight from "../../opencode-logo-light.svg";
import openguiLogoDark from "../../opengui-dark.svg";
import openguiLogoLight from "../../opengui-light.svg";
import { ConnectionPanel } from "./ConnectionPanel";
import { MergeDialog } from "./MergeDialog";
import { getColorBorderClass, SessionContextMenu } from "./SessionContextMenu";
import { ProjectItemMenu, ProjectMenuContent, SessionItemMenu } from "./SidebarItemMenus";
import { ProjectPathDialog } from "./ProjectPathDialog";
import { WorktreeDialog } from "./WorktreeDialog";
import { WorktreeSetupDialog } from "./WorktreeSetupDialog";

type SortableProjectFrameProps = {
  directory: string;
  children: (props: { dragHandleProps: Record<string, unknown> }) => ReactNode;
};

function SortableProjectFrame({ directory, children }: SortableProjectFrameProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: directory,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={isDragging ? "relative z-10 opacity-60" : undefined}
    >
      {children({ dragHandleProps: { ...attributes, ...listeners } })}
    </div>
  );
}

export function AppSidebar({
  detachedProject,
  onOpenSettings,
  onOpenChat,
  settingsActive = false,
}: {
  detachedProject?: string;
  onOpenSettings: () => void;
  onOpenChat: () => void;
  settingsActive?: boolean;
}) {
  const { t } = useTranslation();
  const showDevTag = typeof window !== "undefined" && window.location.protocol !== "file:";
  const { state: sidebarState, setOpen: setSidebarOpen } = useSidebar();
  const {
    selectSession,
    startNewChat,
    startDraftSession,
    deleteSession,
    renameSession,
    removeProject,
    openDirectory,
    connectToProject,
    setSessionColor,
    setSessionTags,
    setSessionPinned,
    moveSessionToProject,
    setProjectPinned,
    registerWorktree,
    unregisterWorktree,
    sendPrompt,
    reorderVisibleProjects,
  } = useActions();
  const {
    sessions,
    activeSessionId,
    busySessionIds,
    queuedPrompts,
    pendingQuestions,
    pendingPermissions,
    unreadSessionIds,
    sessionDrafts,
    sessionMeta,
    namingSessionIds,
    draftSessionDirectory,
  } = useSessionState();

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSessionDirectory =
    activeSession?._projectDir ?? activeSession?.directory ?? draftSessionDirectory ?? null;
  const {
    connections,
    worktreeParents,
    projectMeta,
    isLocalWorkspace,
    activeWorkspace,
    workspaceDirectory,
    defaultChatDirectory,
  } = useConnectionState();

  // Inline rename state
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showRemoteProjectInput, setShowRemoteProjectInput] = useState(false);
  const [remoteProjectPath, setRemoteProjectPath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const startEditing = useCallback((sessionId: string, currentTitle: string) => {
    setEditingSessionId(sessionId);
    setEditValue(currentTitle);
  }, []);

  const commitRename = useCallback(() => {
    if (editingSessionId) {
      const trimmed = editValue.trim();
      if (trimmed && trimmed !== editingSessionId) {
        // Find the session to compare with its current title
        const session = sessions.find((s) => s.id === editingSessionId);
        if (trimmed !== (session?.title || "")) {
          void renameSession(editingSessionId, trimmed);
        }
      }
    }
    setEditingSessionId(null);
    setEditValue("");
  }, [editingSessionId, editValue, sessions, renameSession]);

  const cancelEditing = useCallback(() => {
    setEditingSessionId(null);
    setEditValue("");
  }, []);

  const homeDir = useHomeDir();
  const normalizedRemoteProjectPath = normalizeProjectPath(remoteProjectPath);
  const isWebRuntime =
    typeof navigator !== "undefined" && !navigator.userAgent.includes("Electron");
  const requestProjectPath = useCallback(
    (initialPath?: string) =>
      new Promise<string | null>((resolve) => {
        window.dispatchEvent(
          new CustomEvent("opengui:open-project-path-dialog", {
            detail: { resolve, initialPath },
          }),
        );
      }),
    [],
  );
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const hasActiveSearch = normalizedSearchQuery.length > 0;

  // Set of directories that are worktrees (should be hidden from project list)
  const worktreeDirs = useMemo(() => new Set(Object.keys(worktreeParents)), [worktreeParents]);
  const availableProjectDirectories = useMemo(
    () =>
      (activeWorkspace?.projects ?? []).filter(
        (directory) => projectMeta[normalizeProjectPath(directory)]?.hidden !== true,
      ),
    [activeWorkspace?.projects, projectMeta],
  );
  const isChatSession = useCallback(
    (session: (typeof sessions)[number]) => {
      const meta = sessionMeta[session.id];
      if (meta?.movedToSessionId) return false;
      if (meta?.assignedProjectDir) return false;
      if (meta?.originMode === "chat") return true;
      const directory = normalizeProjectPath(session._projectDir ?? session.directory);
      return Boolean(directory && projectMeta[directory]?.hidden);
    },
    [projectMeta, sessionMeta],
  );

  const sortSessionsForSidebar = useCallback(
    (items: typeof sessions) =>
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

  // Group root sessions by project directory, merging worktree sessions under parent.
  // Uses `_projectDir` (set by the bridge from the connection directory) instead
  // of `session.directory` so that sessions are grouped correctly even when the
  // server stores a slightly different path (symlinks, trailing slashes, etc.).
  const projectGroups = useMemo(() => {
    const openDirectories = Object.keys(connections).filter((dir) =>
      detachedProject ? dir === detachedProject : true,
    );
    const openDirectorySet = new Set(openDirectories.map((dir) => normalizeProjectPath(dir)));
    const rootSessions = sessions.filter((s) => {
      const sessionDir = normalizeProjectPath(s._projectDir ?? s.directory);
      return (
        !s.parentID && openDirectorySet.has(sessionDir) && !sessionMeta[s.id]?.movedToSessionId
      );
    });
    const rootOpenDirectories = openDirectories.filter((dir) => !worktreeDirs.has(dir));
    const workspaceProjects = activeWorkspace?.projects ?? [];
    const orderedRootDirectories = detachedProject
      ? rootOpenDirectories.filter((dir) => dir === detachedProject)
      : [
          ...workspaceProjects.filter((dir) => rootOpenDirectories.includes(dir)),
          ...rootOpenDirectories.filter((dir) => !workspaceProjects.includes(dir)),
        ];
    const groups = new Map<string, typeof rootSessions>();
    for (const dir of orderedRootDirectories) {
      groups.set(dir, []);
    }
    for (const s of rootSessions) {
      const assignedProjectDir = sessionMeta[s.id]?.assignedProjectDir
        ? normalizeProjectPath(sessionMeta[s.id]?.assignedProjectDir ?? "")
        : null;
      if (assignedProjectDir && rootOpenDirectories.includes(assignedProjectDir)) {
        if (!groups.has(assignedProjectDir)) groups.set(assignedProjectDir, []);
        groups.get(assignedProjectDir)?.push(s);
        continue;
      }
      if (isChatSession(s)) continue;
      const sessionDir = normalizeProjectPath(s._projectDir ?? s.directory);
      if (!openDirectorySet.has(sessionDir)) continue;
      // If session belongs to a worktree, group it under the parent project
      const parentDir = worktreeParents[sessionDir]?.parentDir;
      const groupDir = parentDir ?? sessionDir;
      if (!groups.has(groupDir)) groups.set(groupDir, []);
      groups.get(groupDir)?.push(s);
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
    worktreeDirs,
    detachedProject,
    activeWorkspace,
    sessionMeta,
    isChatSession,
    sortSessionsForSidebar,
  ]);
  const chatSessions = useMemo(
    () =>
      sortSessionsForSidebar(
        sessions.filter(
          (session) =>
            !session.parentID &&
            !sessionMeta[session.id]?.movedToSessionId &&
            isChatSession(session),
        ),
      ),
    [sessions, isChatSession, sessionMeta, sortSessionsForSidebar],
  );
  const filteredChatSessions = useMemo(() => {
    if (!hasActiveSearch) return chatSessions;
    return chatSessions.filter((session) => {
      const sessionTags = sessionMeta[session.id]?.tags ?? [];
      const sessionSearchText =
        `${session.title || t("sidebar.untitled")} ${sessionTags.join(" ")}`.toLowerCase();
      return sessionSearchText.includes(normalizedSearchQuery);
    });
  }, [chatSessions, hasActiveSearch, normalizedSearchQuery, sessionMeta, t]);

  // Worktree dialog state
  const [worktreeDialogDir, setWorktreeDialogDir] = useState<string | null>(null);
  // Post-creation setup dialog state
  const [setupWorktreePath, setSetupWorktreePath] = useState<string | null>(null);
  // Per-project: is it a git repo? (checked on context menu open)
  const [isGitRepo, setIsGitRepo] = useState<Record<string, boolean>>({});
  // Per-project: known worktrees (fetched on context menu open)
  const [knownWorktrees, setKnownWorktrees] = useState<Record<string, GitWorktree[]>>({});
  // Merge dialog state
  const [mergeInfo, setMergeInfo] = useState<{
    mainDir: string;
    branch: string;
    worktreePath: string;
  } | null>(null);
  const fixWithAiTimeoutRef = useRef<number | null>(null);
  // Per-project: remote URL (for PR links)
  const [remoteUrls, setRemoteUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    return () => {
      if (fixWithAiTimeoutRef.current !== null) {
        window.clearTimeout(fixWithAiTimeoutRef.current);
        fixWithAiTimeoutRef.current = null;
      }
    };
  }, []);

  /** Refresh git info for a project directory (is repo + worktree list + remote). */
  const refreshGitInfo = useCallback(
    async (directory: string) => {
      const git = window.electronAPI?.git;
      if (!git) return;
      const normalizedDirectory = normalizeProjectPath(directory);
      const repoRes = await git.isRepo(normalizedDirectory);
      const isRepo = repoRes.success && repoRes.data === true;
      setIsGitRepo((prev) => ({ ...prev, [normalizedDirectory]: isRepo }));
      if (isRepo) {
        const [wtRes, remoteRes] = await Promise.all([
          git.listWorktrees(normalizedDirectory),
          git.getRemoteUrl(normalizedDirectory),
        ]);
        if (wtRes.success && wtRes.data) {
          const actualWorktrees = (wtRes.data ?? []).map((wt) => ({
            ...wt,
            path: normalizeProjectPath(wt.path),
          }));
          setKnownWorktrees((prev) => ({
            ...prev,
            [normalizedDirectory]: actualWorktrees,
          }));
          const actualPaths = new Set(actualWorktrees.map((wt) => wt.path));
          for (const wt of actualWorktrees) {
            if (wt.path === normalizedDirectory) continue;
            if (!worktreeParents[wt.path]) {
              registerWorktree(wt.path, normalizedDirectory, wt.branch ?? "unknown");
            }
          }
          for (const [wtDir, info] of Object.entries(worktreeParents)) {
            if (info.parentDir === normalizedDirectory && !actualPaths.has(wtDir)) {
              unregisterWorktree(wtDir);
            }
          }
        }
        if (remoteRes.success && remoteRes.data) {
          setRemoteUrls((prev) => ({
            ...prev,
            [normalizedDirectory]: remoteRes.data ?? "",
          }));
        }
      }
    },
    [registerWorktree, worktreeParents, unregisterWorktree],
  );

  // Track collapsed state per project
  const [collapsed, setCollapsed] = useState<SidebarCollapsedProjects>(() =>
    getSidebarCollapsedProjects(),
  );
  const toggleCollapsed = useCallback((dir: string) => {
    setCollapsed((prev) => toggleSidebarProjectCollapsed(prev, dir));
  }, []);

  // Prune stale git info entries when projects are removed
  const openDirectories = useMemo(() => Object.keys(connections), [connections]);
  const activeWorkspaceProjectDirectories = useMemo(
    () => activeWorkspace?.projects ?? [],
    [activeWorkspace?.projects],
  );
  useEffect(() => {
    const validDirs = new Set(openDirectories);
    setIsGitRepo((prev) => pruneRecord(prev, validDirs));
    setKnownWorktrees((prev) => pruneRecord(prev, validDirs));
    setRemoteUrls((prev) => pruneRecord(prev, validDirs));

    // Keep collapsed project state across app startup. Connections hydrate after
    // localStorage state, so pruning against an empty/partial connection list can
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
  const [visibleByProject, setVisibleByProject] = useState<Record<string, number>>({});
  const [visibleChatCount, setVisibleChatCount] = useState(SESSION_PAGE_SIZE);
  const [projectPopover, setProjectPopover] = useState<{
    directory: string;
    top: number;
  } | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (sidebarState !== "collapsed") {
      setProjectPopover(null);
    }
  }, [sidebarState]);

  const closeProjectPopover = useCallback(() => setProjectPopover(null), []);
  useOutsideClick(popoverRef, closeProjectPopover, !!projectPopover);

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
            `${session.title || t("sidebar.untitled")} ${sessionTags.join(" ")}`.toLowerCase();
          return sessionSearchText.includes(normalizedSearchQuery);
        });
        return matchingSessions.length > 0 ? ([directory, matchingSessions] as const) : null;
      })
      .filter((entry): entry is (typeof projectEntries)[number] => entry !== null);
  }, [hasActiveSearch, normalizedSearchQuery, projectEntries, sessionMeta, t]);
  const {
    pinnedEntries,
    projectEntries: filteredProjectEntries,
    projectSessionsByDirectory,
  } = useMemo(
    () =>
      partitionSidebarPins({
        projectEntries: searchFilteredProjectEntries,
        sessionMeta,
        projectMeta,
        worktreeParents,
      }),
    [projectMeta, searchFilteredProjectEntries, sessionMeta, worktreeParents],
  );
  const popoverSessions = projectPopover
    ? (projectSessionsByDirectory[projectPopover.directory] ?? [])
    : [];
  const visibleChatSessions = filteredChatSessions.slice(0, visibleChatCount);
  const hasMoreChats = filteredChatSessions.length > visibleChatCount;
  const canShowLessChats = visibleChatCount > SESSION_PAGE_SIZE;
  const sortableProjectDirectories = useMemo(
    () => filteredProjectEntries.map(([directory]) => directory),
    [filteredProjectEntries],
  );
  const canReorderProjects =
    !detachedProject &&
    !hasActiveSearch &&
    sidebarState !== "collapsed" &&
    sortableProjectDirectories.length > 1;
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = sortableProjectDirectories.indexOf(String(active.id));
      const newIndex = sortableProjectDirectories.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return;
      reorderVisibleProjects(arrayMove(sortableProjectDirectories, oldIndex, newIndex));
    },
    [reorderVisibleProjects, sortableProjectDirectories],
  );
  const projectLabel = detachedProject ? getProjectName(detachedProject) : t("sidebar.projects");

  useEffect(() => {
    const focusSidebarSearch = () => {
      setSidebarOpen(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };

    window.addEventListener("focus-sidebar-search", focusSidebarSearch);
    return () => {
      window.removeEventListener("focus-sidebar-search", focusSidebarSearch);
    };
  }, [setSidebarOpen]);

  const handleAddProject = useCallback(async () => {
    if (isLocalWorkspace) {
      const dir = isWebRuntime
        ? await requestProjectPath(workspaceDirectory ?? undefined)
        : await openDirectory();
      if (dir) void connectToProject(dir);
      return;
    }
    setShowRemoteProjectInput(true);
  }, [
    connectToProject,
    isLocalWorkspace,
    isWebRuntime,
    openDirectory,
    requestProjectPath,
    workspaceDirectory,
  ]);

  const hasUnsentDraft = useCallback(
    (sessionId: string) => Boolean(sessionDrafts[`session:${sessionId}`]?.trim()),
    [sessionDrafts],
  );

  const revealSessionInProject = useCallback((directory: string) => {
    const normalizedDirectory = normalizeProjectPath(directory);
    if (!normalizedDirectory) return;
    setCollapsed((prev) => {
      if (!prev[normalizedDirectory]) return prev;
      const { [normalizedDirectory]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  const renderSessionRow = (session: (typeof sessions)[number], directory: string) => {
    const isActive = session.id === activeSessionId;
    const isBusy = busySessionIds.has(session.id);
    const isUnread = unreadSessionIds.has(session.id);
    const hasUnsent = hasUnsentDraft(session.id);
    const queueCount = (queuedPrompts[session.id] ?? []).length;
    const hasQuestion = !!pendingQuestions[session.id];
    const hasPermission = !!pendingPermissions[session.id];
    const meta = sessionMeta[session.id];
    const hasColor = !!meta?.color;
    const colorBorderClass = hasColor
      ? `border-l-[3px] -ml-[3px] ${getColorBorderClass(meta.color)}`
      : "";
    const tags = meta?.tags ?? [];
    const isPinned = !!meta?.pinnedAt;
    const isNaming = namingSessionIds.has(session.id);
    const isWorktreeSession =
      session.directory !== directory &&
      worktreeParents[session.directory]?.parentDir === directory;
    const worktreeBranch = isWorktreeSession ? getProjectName(session.directory) : null;
    return (
      <SessionContextMenu
        key={session.id}
        currentColor={meta?.color}
        currentTags={tags}
        availableProjects={availableProjectDirectories}
        assignedProjectDir={meta?.assignedProjectDir ?? null}
        pinned={isPinned}
        onTogglePin={() => setSessionPinned(session.id, !isPinned)}
        onSetColor={(color) => setSessionColor(session.id, color)}
        onSetTags={(newTags) => setSessionTags(session.id, newTags)}
        onMoveToProject={(projectDirectory) => {
          revealSessionInProject(projectDirectory);
          void moveSessionToProject(session.id, projectDirectory);
        }}
        onRename={() => startEditing(session.id, isNaming ? "" : session.title || "")}
        onDelete={() => deleteSession(session.id)}
      >
        <SidebarMenuItem>
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarMenuButton
                asChild
                tooltip={isNaming ? undefined : session.title}
                isActive={isActive}
                className={`group/session min-w-0 ${colorBorderClass}`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (editingSessionId === session.id) return;
                    void selectSession(session.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      if (editingSessionId === session.id) return;
                      void selectSession(session.id);
                    }
                  }}
                >
                  <span className="relative shrink-0">
                    {isBusy ? (
                      <Spinner className="size-4 text-muted-foreground" />
                    ) : isWorktreeSession ? (
                      <GitBranch className="size-4" />
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
                  {editingSessionId === session.id ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelEditing();
                        }
                        e.stopPropagation();
                      }}
                      onBlur={commitRename}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      autoFocus
                      className="min-w-0 flex-1 truncate bg-transparent outline-none text-sm border-b border-primary"
                    />
                  ) : isNaming ? (
                    <Skeleton className="h-4 min-w-0 flex-1 bg-sidebar-foreground/20" />
                  ) : (
                    <span
                      role="textbox"
                      tabIndex={-1}
                      className={`truncate min-w-0 flex-1 ${isUnread ? "font-semibold" : ""}`}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startEditing(session.id, session.title || "");
                      }}
                    >
                      {session.title || t("sidebar.untitled")}
                    </span>
                  )}
                  {session._backendId && (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0 text-[9px] font-medium text-muted-foreground">
                      {AGENT_BACKEND_LABELS[session._backendId]}
                    </span>
                  )}
                  {worktreeBranch && (
                    <span className="shrink-0 rounded-full bg-purple-500/15 text-purple-500 px-1.5 py-0 text-[9px] font-medium truncate max-w-[4rem]">
                      {worktreeBranch}
                    </span>
                  )}
                  {tags.length > 0 && (
                    <span className="shrink-0 flex gap-0.5 overflow-hidden max-w-[4rem]">
                      {tags.slice(0, 2).map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-muted px-1.5 py-0 text-[9px] font-medium text-muted-foreground truncate max-w-[3rem]"
                        >
                          {tag}
                        </span>
                      ))}
                      {tags.length > 2 && (
                        <span className="text-[9px] text-muted-foreground">+{tags.length - 2}</span>
                      )}
                    </span>
                  )}
                  {hasPermission && (
                    <span className="rounded-full bg-orange-500/15 text-orange-500 text-[10px] font-bold">
                      <ShieldAlert className="size-4" />
                    </span>
                  )}
                  {hasQuestion && (
                    <span className="rounded-full bg-amber-500/15 text-amber-500 text-[10px] font-bold">
                      <BadgeQuestionMark className="size-4" />
                    </span>
                  )}
                  {queueCount > 0 && (
                    <span className="shrink-0 rounded-full bg-primary/15 text-primary text-[10px] font-medium px-1.5 py-0.5 tabular-nums">
                      {queueCount}
                    </span>
                  )}
                  <SessionItemMenu
                    pinned={isPinned}
                    currentColor={meta?.color}
                    currentTags={tags}
                    availableProjects={availableProjectDirectories}
                    assignedProjectDir={meta?.assignedProjectDir ?? null}
                    onTogglePin={() => setSessionPinned(session.id, !isPinned)}
                    onSetColor={(color) => setSessionColor(session.id, color)}
                    onSetTags={(newTags) => setSessionTags(session.id, newTags)}
                    onMoveToProject={(projectDirectory) =>
                      void moveSessionToProject(session.id, projectDirectory)
                    }
                    onRename={() => startEditing(session.id, session.title || "")}
                    onDelete={() => deleteSession(session.id)}
                  />
                </div>
              </SidebarMenuButton>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              align="center"
              hidden={editingSessionId === session.id || isNaming}
            >
              {session.title || t("sidebar.untitled")}
            </TooltipContent>
          </Tooltip>
        </SidebarMenuItem>
      </SessionContextMenu>
    );
  };

  const renderProjectEntry = (
    directory: string,
    dirSessions: typeof sessions,
    options?: { canDrag?: boolean; dragHandleProps?: Record<string, unknown> },
  ) => {
    const isCollapsed = hasActiveSearch ? false : isSidebarProjectCollapsed(collapsed, directory);
    const connStatus = connections[directory];
    const isProjectConnected = connStatus?.state === "connected";
    const isProjectConnecting =
      connStatus?.state === "connecting" || connStatus?.state === "reconnecting";
    const visibleCount = visibleByProject[directory] ?? SESSION_PAGE_SIZE;
    const visibleSessions = dirSessions.slice(0, visibleCount);
    const hasMoreSessions = dirSessions.length > visibleCount;
    const canShowLess = visibleCount > SESSION_PAGE_SIZE;
    const canDragProject = !!options?.canDrag;
    const dragHandleProps = options?.dragHandleProps ?? {};
    const normalizedDirectory = normalizeProjectPath(directory);
    const isPinned = !!projectMeta[normalizedDirectory]?.pinnedAt;

    return (
      <div key={directory} className="mb-1">
        <SidebarMenu>
          <ContextMenu.Root
            onOpenChange={(open) => {
              if (open) void refreshGitInfo(directory);
            }}
          >
            <ContextMenu.Trigger asChild>
              <SidebarMenuItem className="overflow-visible">
                <SidebarMenuButton
                  asChild
                  tooltip={abbreviatePath(directory, homeDir)}
                  className="group/project font-medium min-w-0"
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      const target = event.target;
                      if (target instanceof Element && target.closest("[data-project-action]")) {
                        return;
                      }
                      if (sidebarState === "collapsed") {
                        event.preventDefault();
                        event.stopPropagation();
                        const rect = (
                          event.currentTarget as HTMLDivElement
                        ).getBoundingClientRect();
                        setProjectPopover((prev) =>
                          prev?.directory === directory ? null : { directory, top: rect.top },
                        );
                        return;
                      }
                      toggleCollapsed(directory);
                    }}
                    onKeyDown={(event) => {
                      const target = event.target;
                      if (target instanceof Element && target.closest("[data-project-action]")) {
                        return;
                      }
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleCollapsed(directory);
                      }
                    }}
                  >
                    {isProjectConnecting ? (
                      <Spinner className="shrink-0 size-4 text-muted-foreground" />
                    ) : canDragProject ? (
                      <span className="relative -ml-1 flex size-5 shrink-0 items-center justify-center">
                        <ChevronRight
                          className={`size-4 transition-all group-hover/project:scale-75 group-hover/project:opacity-0 ${
                            !isCollapsed ? "rotate-90" : ""
                          }`}
                        />
                        <span
                          {...dragHandleProps}
                          data-project-action
                          data-project-drag-handle
                          className="absolute inset-0 flex cursor-grab items-center justify-center rounded text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground active:cursor-grabbing group-hover/project:opacity-100"
                          aria-label={`Reorder ${getProjectName(directory)}`}
                        >
                          <GripVertical className="size-3.5" />
                        </span>
                      </span>
                    ) : sidebarState === "collapsed" ? (
                      <FolderOpen className="shrink-0 size-4" />
                    ) : (
                      <ChevronRight
                        className={`shrink-0 size-4 transition-transform ${
                          !isCollapsed ? "rotate-90" : ""
                        }`}
                      />
                    )}
                    <span className="truncate min-w-0 flex-1">{getProjectName(directory)}</span>
                    {isProjectConnected && (
                      <div
                        role="button"
                        data-project-action
                        tabIndex={0}
                        className="ml-auto opacity-0 group-hover/project:opacity-100 transition-opacity shrink-0 size-6 rounded-md flex items-center justify-center hover:bg-accent group-data-[collapsible=icon]:hidden"
                        onClick={(e) => {
                          e.stopPropagation();
                          startDraftSession(directory);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            startDraftSession(directory);
                          }
                        }}
                      >
                        <SquarePen className="size-3" />
                      </div>
                    )}
                    <ProjectItemMenu
                      pinned={isPinned}
                      canCreateSession={isProjectConnected}
                      onTogglePin={() => setProjectPinned(directory, !isPinned)}
                      onNewSession={() => startDraftSession(directory)}
                      canRemove={!detachedProject}
                      onRemove={() => {
                        if (detachedProject) return;
                        void removeProject(directory);
                      }}
                      directory={directory}
                      isLocalWorkspace={isLocalWorkspace}
                      isGitRepo={!!isGitRepo[directory]}
                      worktrees={knownWorktrees[directory] ?? []}
                      worktreeParents={worktreeParents}
                      onNewWorktree={() => setWorktreeDialogDir(directory)}
                      onMergeWorktree={(wt) => {
                        if (!wt.branch) return;
                        setMergeInfo({
                          mainDir: directory,
                          branch: wt.branch,
                          worktreePath: wt.path,
                        });
                      }}
                      onOpenWorktreePr={(wt) => {
                        if (!wt.branch) return;
                        const remote = remoteUrls[directory];
                        if (!remote) return;
                        const url = buildPRUrl(remote, wt.branch);
                        if (url) openExternalLink(url);
                      }}
                      onRemoveWorktree={async (wt) => {
                        if (worktreeDirs.has(wt.path)) {
                          unregisterWorktree(wt.path);
                          await removeProject(wt.path);
                        }
                        await window.electronAPI?.git?.removeWorktree(directory, wt.path);
                        void refreshGitInfo(directory);
                      }}
                    />
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content
                className="z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
                alignOffset={5}
              >
                <ProjectMenuContent
                  kind="context"
                  pinned={isPinned}
                  canCreateSession={isProjectConnected}
                  onTogglePin={() => setProjectPinned(directory, !isPinned)}
                  onNewSession={() => startDraftSession(directory)}
                  canRemove={!detachedProject}
                  onRemove={() => {
                    if (detachedProject) return;
                    void removeProject(directory);
                  }}
                  directory={directory}
                  isLocalWorkspace={isLocalWorkspace}
                  isGitRepo={!!isGitRepo[directory]}
                  worktrees={knownWorktrees[directory] ?? []}
                  worktreeParents={worktreeParents}
                  onNewWorktree={() => setWorktreeDialogDir(directory)}
                  onMergeWorktree={(wt) => {
                    if (!wt.branch) return;
                    setMergeInfo({
                      mainDir: directory,
                      branch: wt.branch,
                      worktreePath: wt.path,
                    });
                  }}
                  onOpenWorktreePr={(wt) => {
                    if (!wt.branch) return;
                    const remote = remoteUrls[directory];
                    if (!remote) return;
                    const url = buildPRUrl(remote, wt.branch);
                    if (url) openExternalLink(url);
                  }}
                  onRemoveWorktree={async (wt) => {
                    if (worktreeDirs.has(wt.path)) {
                      unregisterWorktree(wt.path);
                      await removeProject(wt.path);
                    }
                    await window.electronAPI?.git?.removeWorktree(directory, wt.path);
                    void refreshGitInfo(directory);
                  }}
                />
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        </SidebarMenu>
        {!isCollapsed && sidebarState !== "collapsed" && (
          <SidebarMenu className="ml-3 border-l border-sidebar-border pl-2 w-[calc(100%-0.75rem)] overflow-x-hidden">
            {dirSessions.length === 0 ? (
              <div className="px-2 py-1 text-[11px] text-muted-foreground">
                {t("sidebar.noSessionsYet")}
              </div>
            ) : (
              <>
                {visibleSessions.map((session) => renderSessionRow(session, directory))}
                {hasMoreSessions && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => {
                        setVisibleByProject((prev) => ({
                          ...prev,
                          [directory]: (prev[directory] ?? SESSION_PAGE_SIZE) + SESSION_PAGE_SIZE,
                        }));
                      }}
                      className="text-muted-foreground min-w-0"
                    >
                      <ChevronDown className="shrink-0" />
                      <span className="truncate">
                        {t("sidebar.loadMore", {
                          count: dirSessions.length - visibleCount,
                        })}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {canShowLess && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => {
                        setVisibleByProject((prev) => ({
                          ...prev,
                          [directory]: SESSION_PAGE_SIZE,
                        }));
                      }}
                      className="text-muted-foreground min-w-0"
                    >
                      <ChevronUp className="shrink-0" />
                      <span className="truncate">{t("sidebar.showLess")}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </>
            )}
          </SidebarMenu>
        )}
      </div>
    );
  };

  return (
    <Sidebar collapsible="icon" className="select-none relative">
      <SidebarHeader className="border-b border-sidebar-border p-0 gap-0 group-data-[collapsible=icon]:p-2">
        <div
          className="flex items-center justify-center gap-2 h-9 shrink-0 border-b border-sidebar-border group-data-[collapsible=icon]:h-auto group-data-[collapsible=icon]:border-b-0"
          style={
            {
              WebkitAppRegion: "drag",
              userSelect: "none",
              WebkitUserSelect: "none",
            } as React.CSSProperties
          }
        >
          <img
            src={logoDark}
            alt="OpenCode"
            className="size-6 shrink-0 hidden group-data-[collapsible=icon]:dark:block"
          />
          <img
            src={logoLight}
            alt="OpenCode"
            className="size-6 shrink-0 hidden group-data-[collapsible=icon]:block group-data-[collapsible=icon]:dark:hidden"
          />
          <img
            src={openguiLogoDark}
            alt="OpenGUI"
            className="h-5 hidden dark:block group-data-[collapsible=icon]:!hidden"
          />
          <img
            src={openguiLogoLight}
            alt="OpenGUI"
            className="h-5 block dark:hidden group-data-[collapsible=icon]:!hidden"
          />
          {showDevTag && (
            <Badge className="bg-orange-500 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide text-white group-data-[collapsible=icon]:hidden">
              dev
            </Badge>
          )}
        </div>
        <div className="group-data-[collapsible=icon]:hidden border-b border-sidebar-border/60 bg-sidebar/40">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <Input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("sidebar.searchPlaceholder")}
              className="h-8 pl-8 pr-8 text-sm rounded-none border-0 focus:ring-0 focus-visible:ring-0"
            />
            {hasActiveSearch && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  searchInputRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 flex size-4.5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/75 transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
                aria-label={t("sidebar.clearSearch")}
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>
        {!detachedProject && (
          <div className="group-data-[collapsible=icon]:hidden border-b border-sidebar-border">
            <button
              type="button"
              onClick={() => {
                onOpenChat();
                void startNewChat();
              }}
              disabled={!defaultChatDirectory}
              className="flex h-10 w-full items-center gap-2 px-3 text-left text-sm font-medium transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
            >
              <SquarePen className="size-4 shrink-0" />
              <span>{t("sidebar.newChat")}</span>
            </button>
          </div>
        )}
      </SidebarHeader>

      <SidebarContent className="overflow-x-hidden" onClickCapture={onOpenChat}>
        {pinnedEntries.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="!text-sm">{t("sidebar.pinned")}</SidebarGroupLabel>
            <SidebarGroupContent>
              {pinnedEntries.map((entry) =>
                entry.kind === "project"
                  ? renderProjectEntry(entry.directory, entry.sessions)
                  : renderSessionRow(entry.session, entry.projectDirectory),
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {!detachedProject && (
          <SidebarGroup>
            <SidebarGroupLabel className="group/label flex items-center justify-between !text-sm">
              <span>{t("sidebar.chats")}</span>
              <button
                type="button"
                onClick={() => {
                  void startNewChat();
                }}
                disabled={!defaultChatDirectory}
                className="opacity-0 group-hover/label:opacity-100 transition-opacity h-6 w-6 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground"
              >
                <SquarePen className="h-4 w-4" />
              </button>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              {filteredChatSessions.length === 0 ? (
                hasActiveSearch &&
                filteredProjectEntries.length === 0 &&
                pinnedEntries.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-muted-foreground">
                    {t("sidebar.noMatches", { query: searchQuery.trim() })}
                  </div>
                ) : (
                  <div className="px-2 py-1 text-[11px] text-muted-foreground">
                    {t("sidebar.noChats")}
                  </div>
                )
              ) : (
                <SidebarMenu>
                  {visibleChatSessions.map((session) =>
                    renderSessionRow(
                      session,
                      sessionMeta[session.id]?.assignedProjectDir ??
                        normalizeProjectPath(session._projectDir ?? session.directory),
                    ),
                  )}
                  {hasMoreChats && (
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        onClick={() => {
                          setVisibleChatCount((prev) => prev + SESSION_PAGE_SIZE);
                        }}
                        className="text-muted-foreground min-w-0"
                      >
                        <ChevronDown className="shrink-0" />
                        <span className="truncate">
                          {t("sidebar.loadMore", {
                            count: filteredChatSessions.length - visibleChatCount,
                          })}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                  {canShowLessChats && (
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        onClick={() => {
                          setVisibleChatCount(SESSION_PAGE_SIZE);
                        }}
                        className="text-muted-foreground min-w-0"
                      >
                        <ChevronUp className="shrink-0" />
                        <span className="truncate">{t("sidebar.showLess")}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {/* Project groups */}
        {projectGroups.size > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="group/label flex items-center justify-between !text-sm">
              {projectLabel}
              {!detachedProject && (
                <button
                  type="button"
                  onClick={() => {
                    void handleAddProject();
                  }}
                  className="opacity-0 group-hover/label:opacity-100 transition-opacity h-6 w-6 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-4 w-4" />
                </button>
              )}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              {filteredProjectEntries.length === 0 ? (
                hasActiveSearch && pinnedEntries.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-muted-foreground">
                    {t("sidebar.noMatches", { query: searchQuery.trim() })}
                  </div>
                ) : pinnedEntries.length > 0 ? (
                  <div className="px-2 py-3 text-sm text-muted-foreground">
                    {t("sidebar.allProjectsPinned")}
                  </div>
                ) : null
              ) : canReorderProjects ? (
                <DndContext
                  sensors={dndSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleProjectDragEnd}
                >
                  <SortableContext
                    items={sortableProjectDirectories}
                    strategy={verticalListSortingStrategy}
                  >
                    {filteredProjectEntries.map(([directory, dirSessions]) => (
                      <SortableProjectFrame key={directory} directory={directory}>
                        {({ dragHandleProps }) =>
                          renderProjectEntry(directory, dirSessions, {
                            canDrag: true,
                            dragHandleProps,
                          })
                        }
                      </SortableProjectFrame>
                    ))}
                  </SortableContext>
                </DndContext>
              ) : (
                filteredProjectEntries.map(([directory, dirSessions]) =>
                  renderProjectEntry(directory, dirSessions),
                )
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {projectPopover && sidebarState === "collapsed" && (
          <div
            ref={popoverRef}
            className="fixed left-[calc(var(--sidebar-width-icon)+0.125rem)] z-50 w-72 rounded-lg border border-sidebar-border bg-sidebar p-2 shadow-xl"
            style={{
              top: Math.max(8, projectPopover.top - 8),
              maxHeight: "calc(100vh - 1rem)",
            }}
          >
            <div className="mb-1 flex items-center gap-2 px-2 py-1">
              <div className="truncate text-sm font-medium">
                {getProjectName(projectPopover.directory)}
              </div>
              <div className="ml-auto text-xs text-muted-foreground">{popoverSessions.length}</div>
            </div>
            <ul className="max-h-[min(32rem,calc(100vh-5rem))] space-y-1 overflow-y-auto">
              <li>
                <button
                  type="button"
                  onClick={() => {
                    startDraftSession(projectPopover.directory);
                    setProjectPopover(null);
                  }}
                  className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm"
                >
                  <CirclePlus className="size-4 shrink-0" />
                  <span className="truncate">{t("sidebar.newSession")}</span>
                </button>
              </li>
              {popoverSessions.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  {t("sidebar.noSessionsYet")}
                </div>
              ) : (
                popoverSessions.map((session) => {
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
                          setProjectPopover(null);
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
                          <span
                            className={`truncate min-w-0 flex-1 ${isUnread ? "font-semibold" : ""}`}
                          >
                            {session.title || t("sidebar.untitled")}
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
        )}

        {/* Remote path input (shown for remote workspaces, independent of project list) */}
        {showRemoteProjectInput && !isLocalWorkspace && !detachedProject && (
          <div className="mx-3 mt-3 space-y-2 rounded-lg border bg-sidebar-accent/30 p-2 group-data-[collapsible=icon]:hidden">
            <div className="text-[11px] text-muted-foreground">
              Remote path on {activeWorkspace?.name}
            </div>
            <div className="flex gap-2">
              <Input
                autoFocus
                value={remoteProjectPath}
                onChange={(event) => setRemoteProjectPath(event.target.value)}
                placeholder="/remote/path/to/project"
                className="h-8 font-mono text-xs"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setRemoteProjectPath("");
                    setShowRemoteProjectInput(false);
                  }
                  if (event.key === "Enter" && normalizedRemoteProjectPath) {
                    event.preventDefault();
                    void connectToProject(normalizedRemoteProjectPath);
                    setRemoteProjectPath("");
                    setShowRemoteProjectInput(false);
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (!normalizedRemoteProjectPath) return;
                  void connectToProject(normalizedRemoteProjectPath);
                  setRemoteProjectPath("");
                  setShowRemoteProjectInput(false);
                }}
                className="flex h-8 items-center rounded-md bg-primary px-3 text-xs text-primary-foreground"
              >
                Open
              </button>
              <button
                type="button"
                onClick={() => {
                  setRemoteProjectPath("");
                  setShowRemoteProjectInput(false);
                }}
                className="flex h-8 items-center rounded-md border px-3 text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Empty state when no projects at all */}
        {projectGroups.size === 0 &&
          (detachedProject || filteredChatSessions.length === 0) &&
          !hasActiveSearch && (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
              {detachedProject ? (
                <>
                  <p>Project not connected</p>
                  <p className="mt-1 truncate">{abbreviatePath(detachedProject, homeDir)}</p>
                </>
              ) : (
                <>
                  <p>No projects connected</p>
                  <p className="mt-1">
                    Add a project to {activeWorkspace?.name ?? "this workspace"}.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      void handleAddProject();
                    }}
                    className="mt-3 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs text-foreground"
                  >
                    <CirclePlus className="size-4 shrink-0" />
                    <span>{isLocalWorkspace ? "Open folder" : "Open remote path"}</span>
                  </button>
                </>
              )}
            </div>
          )}
      </SidebarContent>

      {!detachedProject && (
        <SidebarFooter className="border-t border-sidebar-border p-0 gap-0">
          {activeSessionDirectory && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-sidebar-border group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-b-0 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-2">
                  <FolderOpen className="size-3.5 shrink-0" />
                  <span className="truncate min-w-0 group-data-[collapsible=icon]:hidden">
                    {abbreviatePath(activeSessionDirectory, homeDir)}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">{activeSessionDirectory}</TooltipContent>
            </Tooltip>
          )}
          <div className="p-1">
            <ConnectionPanel onOpenSettings={onOpenSettings} isActive={settingsActive} />
          </div>
        </SidebarFooter>
      )}

      <SidebarRail />

      <ProjectPathDialog />

      {/* Worktree creation dialog */}
      <WorktreeDialog
        open={worktreeDialogDir !== null}
        onOpenChange={(open) => {
          if (!open) setWorktreeDialogDir(null);
        }}
        directory={worktreeDialogDir ?? ""}
        onCreated={async (worktreePath, branch) => {
          if (!worktreeDialogDir) return;
          // Register in local state with metadata
          registerWorktree(worktreePath, worktreeDialogDir, branch);
          // Connect to the worktree directory
          await connectToProject(worktreePath);
          // Refresh git info
          void refreshGitInfo(worktreeDialogDir);
          // Trigger setup detection dialog
          setSetupWorktreePath(worktreePath);
        }}
      />

      {/* Merge dialog */}
      <MergeDialog
        open={mergeInfo !== null}
        onOpenChange={(open) => {
          if (!open) setMergeInfo(null);
        }}
        mainDirectory={mergeInfo?.mainDir ?? ""}
        branch={mergeInfo?.branch ?? ""}
        onMerged={async (deleteWt) => {
          if (!mergeInfo) return;
          if (deleteWt) {
            // Disconnect + unregister + remove worktree
            if (worktreeDirs.has(mergeInfo.worktreePath)) {
              unregisterWorktree(mergeInfo.worktreePath);
              await removeProject(mergeInfo.worktreePath);
            }
            await window.electronAPI?.git?.removeWorktree(
              mergeInfo.mainDir,
              mergeInfo.worktreePath,
            );
          }
          void refreshGitInfo(mergeInfo.mainDir);
        }}
        onFixWithAI={(conflicts) => {
          if (!mergeInfo) return;
          // Start a new session in the main directory and send the conflict resolution prompt
          startDraftSession(mergeInfo.mainDir);
          // Use a small delay so the draft session is active before sending
          if (fixWithAiTimeoutRef.current !== null) {
            window.clearTimeout(fixWithAiTimeoutRef.current);
          }
          fixWithAiTimeoutRef.current = window.setTimeout(() => {
            const fileList = conflicts.map((f) => `- ${f}`).join("\n");
            void sendPrompt(
              `There are git merge conflicts from merging branch "${mergeInfo.branch}" into the current branch.\n\nThe following files have unresolved conflicts:\n${fileList}\n\nPlease resolve all merge conflicts in these files. Remove all conflict markers (<<<<<<, ======, >>>>>>) and produce the correct merged code. After resolving all conflicts, stage the resolved files with \`git add\` for each file.`,
            );
            fixWithAiTimeoutRef.current = null;
          }, POST_MERGE_DELAY_MS);
        }}
      />
      {/* Post-creation worktree setup dialog */}
      <WorktreeSetupDialog
        open={setupWorktreePath !== null}
        onOpenChange={(open) => {
          if (!open) setSetupWorktreePath(null);
        }}
        worktreePath={setupWorktreePath ?? ""}
      />
    </Sidebar>
  );
}
