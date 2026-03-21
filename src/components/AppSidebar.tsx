import {
	BadgeQuestionMark,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	CirclePlus,
	Copy,
	ExternalLink,
	FolderOpen,
	GitBranch,
	GitMerge,
	MessageSquare,
	Monitor,
	Plus,
	Settings,
	ShieldAlert,
	SquarePen,
	Terminal,
	Trash2,
	X,
} from "lucide-react";
import { ContextMenu } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHomeDir } from "@/hooks/use-home-dir";
import {
	hasAnyConnection,
	useActions,
	useConnectionState,
	useSessionState,
} from "@/hooks/use-opencode";
import { useOutsideClick } from "@/hooks/use-outside-click";
import {
	CTX_ITEM_CLASS,
	CTX_SEPARATOR_CLASS,
	CTX_SUBTRIGGER_CLASS,
	POST_MERGE_DELAY_MS,
	SESSION_PAGE_SIZE,
	STORAGE_KEYS,
} from "@/lib/constants";
import { storageGet } from "@/lib/safe-storage";
import {
	abbreviatePath,
	buildPRUrl,
	formatTimeAgo,
	getProjectName,
	openExternalLink,
} from "@/lib/utils";
import type { GitWorktree } from "@/types/electron";
import logoDark from "../../opencode-logo-dark.svg";
import logoLight from "../../opencode-logo-light.svg";
import openguiLogoDark from "../../opengui-dark.svg";
import openguiLogoLight from "../../opengui-light.svg";
import { ConnectionPanel } from "./ConnectionPanel";
import { MergeDialog } from "./MergeDialog";
import { getColorBorderClass, SessionContextMenu } from "./SessionContextMenu";
import { WorktreeDialog } from "./WorktreeDialog";
import { WorktreeSetupDialog } from "./WorktreeSetupDialog";

export function AppSidebar({
	detachedProject,
	hiddenProjects,
}: {
	detachedProject?: string;
	hiddenProjects?: string[];
}) {
	const { state: sidebarState } = useSidebar();
	const {
		selectSession,
		startDraftSession,
		deleteSession,
		renameSession,
		removeProject,
		openDirectory,
		connectToProject,
		setSessionColor,
		setSessionTags,
		registerWorktree,
		unregisterWorktree,
		sendPrompt,
	} = useActions();
	const {
		sessions,
		activeSessionId,
		busySessionIds,
		queuedPrompts,
		pendingQuestions,
		pendingPermissions,
		temporarySessions,
		unreadSessionIds,
		sessionDrafts,
		sessionMeta,
	} = useSessionState();
	const { connections, worktreeParents } = useConnectionState();

	const isConnected = hasAnyConnection(connections);

	// Inline rename state
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	const editInputRef = useRef<HTMLInputElement>(null);

	const startEditing = useCallback(
		(sessionId: string, currentTitle: string) => {
			setEditingSessionId(sessionId);
			setEditValue(currentTitle);
		},
		[],
	);

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

	// Set of directories that are worktrees (should be hidden from project list)
	const worktreeDirs = useMemo(
		() => new Set(Object.keys(worktreeParents)),
		[worktreeParents],
	);

	// Group root sessions by project directory, merging worktree sessions under parent.
	// Uses `_projectDir` (set by the bridge from the connection directory) instead
	// of `session.directory` so that sessions are grouped correctly even when the
	// server stores a slightly different path (symlinks, trailing slashes, etc.).
	const hiddenProjectSet = useMemo(
		() => new Set(hiddenProjects ?? []),
		[hiddenProjects],
	);

	const projectGroups = useMemo(() => {
		const openDirectories = Object.keys(connections).filter((dir) =>
			detachedProject ? dir === detachedProject : !hiddenProjectSet.has(dir),
		);
		const rootSessions = sessions.filter(
			(s) =>
				!s.parentID &&
				openDirectories.includes(s._projectDir ?? s.directory) &&
				!temporarySessions.has(s.id),
		);
		const groups = new Map<string, typeof rootSessions>();
		// Only show non-worktree directories as top-level projects
		for (const dir of openDirectories) {
			if (!worktreeDirs.has(dir)) {
				groups.set(dir, []);
			}
		}
		for (const s of rootSessions) {
			const sessionDir = s._projectDir ?? s.directory;
			// If session belongs to a worktree, group it under the parent project
			const parentDir = worktreeParents[sessionDir]?.parentDir;
			const groupDir = parentDir ?? sessionDir;
			if (!groups.has(groupDir)) groups.set(groupDir, []);
			groups.get(groupDir)?.push(s);
		}
		return groups;
	}, [
		sessions,
		connections,
		temporarySessions,
		worktreeParents,
		worktreeDirs,
		detachedProject,
		hiddenProjectSet,
	]);

	// Worktree dialog state
	const [worktreeDialogDir, setWorktreeDialogDir] = useState<string | null>(
		null,
	);
	// Post-creation setup dialog state
	const [setupWorktreePath, setSetupWorktreePath] = useState<string | null>(
		null,
	);
	// Per-project: is it a git repo? (checked on context menu open)
	const [isGitRepo, setIsGitRepo] = useState<Record<string, boolean>>({});
	// Per-project: known worktrees (fetched on context menu open)
	const [knownWorktrees, setKnownWorktrees] = useState<
		Record<string, GitWorktree[]>
	>({});
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
	const refreshGitInfo = useCallback(async (directory: string) => {
		const git = window.electronAPI?.git;
		if (!git) return;
		const repoRes = await git.isRepo(directory);
		const isRepo = repoRes.success && repoRes.data === true;
		setIsGitRepo((prev) => ({ ...prev, [directory]: isRepo }));
		if (isRepo) {
			const [wtRes, remoteRes] = await Promise.all([
				git.listWorktrees(directory),
				git.getRemoteUrl(directory),
			]);
			if (wtRes.success && wtRes.data) {
				setKnownWorktrees((prev) => ({
					...prev,
					[directory]: wtRes.data ?? [],
				}));
			}
			if (remoteRes.success && remoteRes.data) {
				setRemoteUrls((prev) => ({
					...prev,
					[directory]: remoteRes.data ?? "",
				}));
			}
		}
	}, []);

	// Track collapsed state per project
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const toggleCollapsed = useCallback((dir: string) => {
		setCollapsed((prev) => ({ ...prev, [dir]: !prev[dir] }));
	}, []);
	const [visibleByProject, setVisibleByProject] = useState<
		Record<string, number>
	>({});
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

	const popoverSessions = projectPopover
		? (projectGroups.get(projectPopover.directory) ?? [])
		: [];
	const projectLabel = detachedProject
		? getProjectName(detachedProject)
		: "Your projects";

	const hasUnsentDraft = useCallback(
		(sessionId: string) =>
			Boolean(sessionDrafts[`session:${sessionId}`]?.trim()),
		[sessionDrafts],
	);

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
				</div>
			</SidebarHeader>

			<SidebarContent className="overflow-x-hidden">
				{/* Project groups */}
				{projectGroups.size > 0 && (
					<SidebarGroup>
						<SidebarGroupLabel className="group/label flex items-center justify-between !text-sm">
							{projectLabel}
							{!detachedProject && isConnected && (
								<button
									type="button"
									onClick={async () => {
										const dir = await openDirectory();
										if (dir) void connectToProject(dir);
									}}
									className="opacity-0 group-hover/label:opacity-100 transition-opacity h-6 w-6 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground"
								>
									<Plus className="h-4 w-4" />
								</button>
							)}
						</SidebarGroupLabel>
						<SidebarGroupContent>
							{Array.from(projectGroups).map(([directory, dirSessions]) => {
								const isCollapsed = collapsed[directory] ?? false;
								const connStatus = connections[directory];
								const isProjectConnected = connStatus?.state === "connected";
								const isProjectConnecting =
									connStatus?.state === "connecting" ||
									connStatus?.state === "reconnecting";
								const visibleCount =
									visibleByProject[directory] ?? SESSION_PAGE_SIZE;
								const visibleSessions = dirSessions.slice(0, visibleCount);
								const hasMoreSessions = dirSessions.length > visibleCount;
								const canShowLess = visibleCount > SESSION_PAGE_SIZE;

								return (
									<div key={directory} className="mb-1">
										{/* Project header */}
										<SidebarMenu>
											<ContextMenu.Root
												onOpenChange={(open) => {
													if (open) void refreshGitInfo(directory);
												}}
											>
												<ContextMenu.Trigger asChild>
													<SidebarMenuItem>
														<SidebarMenuButton
															tooltip={abbreviatePath(directory, homeDir)}
															onClick={(event) => {
																if (sidebarState === "collapsed") {
																	event.preventDefault();
																	event.stopPropagation();
																	const rect = (
																		event.currentTarget as HTMLButtonElement
																	).getBoundingClientRect();
																	setProjectPopover((prev) =>
																		prev?.directory === directory
																			? null
																			: { directory, top: rect.top },
																	);
																	return;
																}
																toggleCollapsed(directory);
															}}
															className="group/project font-medium min-w-0"
														>
															{isProjectConnecting ? (
																<Spinner className="shrink-0 size-4 text-muted-foreground" />
															) : sidebarState === "collapsed" ? (
																<FolderOpen className="shrink-0 size-4" />
															) : (
																<ChevronRight
																	className={`shrink-0 size-4 transition-transform ${
																		!isCollapsed ? "rotate-90" : ""
																	}`}
																/>
															)}
															<span className="truncate min-w-0 flex-1">
																{getProjectName(directory)}
															</span>
															{/* New session for this project */}
															{isProjectConnected && (
																// biome-ignore lint/a11y/useSemanticElements: nested inside SidebarMenuButton (already a <button>), so we must use a <div>
																<div
																	role="button"
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
															{!detachedProject && (
																<>
																	{/* Remove project */}
																	{/* biome-ignore lint/a11y/useSemanticElements: nested inside SidebarMenuButton (already a <button>) */}
																	<div
																		role="button"
																		tabIndex={0}
																		className="opacity-0 group-hover/project:opacity-100 transition-opacity shrink-0 size-6 rounded-md flex items-center justify-center hover:bg-accent group-data-[collapsible=icon]:hidden"
																		onClick={(e) => {
																			e.stopPropagation();
																			void removeProject(directory);
																		}}
																		onKeyDown={(e) => {
																			if (e.key === "Enter" || e.key === " ") {
																				e.stopPropagation();
																				void removeProject(directory);
																			}
																		}}
																	>
																		<X className="size-3" />
																	</div>
																</>
															)}
														</SidebarMenuButton>
													</SidebarMenuItem>
												</ContextMenu.Trigger>
												<ContextMenu.Portal>
													<ContextMenu.Content
														className="z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
														alignOffset={5}
													>
														<ContextMenu.Item
															className={CTX_ITEM_CLASS}
															onSelect={() => {
																void navigator.clipboard.writeText(directory);
															}}
														>
															<Copy className="size-4" />
															<span>Copy absolute path</span>
														</ContextMenu.Item>
														<ContextMenu.Item
															className={CTX_ITEM_CLASS}
															onSelect={() => {
																void window.electronAPI?.openInFileBrowser(
																	directory,
																	storageGet(STORAGE_KEYS.FILE_MANAGER) ?? "",
																);
															}}
														>
															<FolderOpen className="size-4" />
															<span>Open in file browser</span>
														</ContextMenu.Item>
														<ContextMenu.Item
															className={CTX_ITEM_CLASS}
															onSelect={() => {
																void window.electronAPI?.openInTerminal(
																	directory,
																	storageGet(STORAGE_KEYS.TERMINAL) ?? "",
																);
															}}
														>
															<Terminal className="size-4" />
															<span>Open in terminal</span>
														</ContextMenu.Item>

														{!detachedProject && (
															<>
																<ContextMenu.Separator
																	className={CTX_SEPARATOR_CLASS}
																/>
																<ContextMenu.Item
																	className={CTX_ITEM_CLASS}
																	onSelect={() => {
																		void window.electronAPI?.detachProject(
																			directory,
																		);
																	}}
																>
																	<Monitor className="size-4" />
																	<span>Detach project</span>
																</ContextMenu.Item>
															</>
														)}

														{/* Git worktree options (only for git repos) */}
														{isGitRepo[directory] && (
															<>
																<ContextMenu.Separator
																	className={CTX_SEPARATOR_CLASS}
																/>
																<ContextMenu.Item
																	className={CTX_ITEM_CLASS}
																	onSelect={() =>
																		setWorktreeDialogDir(directory)
																	}
																>
																	<GitBranch className="size-4" />
																	<span>New worktree...</span>
																</ContextMenu.Item>
																{/* List existing worktrees (excluding the main repo itself) */}
																{(knownWorktrees[directory] ?? []).filter(
																	(wt) => wt.path !== directory,
																).length > 0 && (
																	<ContextMenu.Sub>
																		<ContextMenu.SubTrigger
																			className={CTX_SUBTRIGGER_CLASS}
																		>
																			<GitBranch className="size-4" />
																			<span>Worktrees</span>
																		</ContextMenu.SubTrigger>
																		<ContextMenu.Portal>
																			<ContextMenu.SubContent
																				className="z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
																				sideOffset={4}
																			>
																				{(knownWorktrees[directory] ?? [])
																					.filter((wt) => wt.path !== directory)
																					.map((wt) => (
																						<ContextMenu.Sub key={wt.path}>
																							<ContextMenu.SubTrigger
																								className={CTX_SUBTRIGGER_CLASS}
																							>
																								<div className="flex flex-col truncate">
																									<span className="truncate">
																										{wt.branch ??
																											getProjectName(wt.path)}
																									</span>
																									{(() => {
																										const meta =
																											worktreeParents[wt.path];
																										return meta ? (
																											<span className="text-[10px] text-muted-foreground">
																												{formatTimeAgo(
																													meta.createdAt,
																												)}
																											</span>
																										) : null;
																									})()}
																								</div>
																							</ContextMenu.SubTrigger>
																							<ContextMenu.Portal>
																								<ContextMenu.SubContent
																									className="z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
																									sideOffset={4}
																								>
																									{wt.branch && (
																										<ContextMenu.Item
																											className={CTX_ITEM_CLASS}
																											onSelect={() => {
																												setMergeInfo({
																													mainDir: directory,
																													branch:
																														wt.branch ?? "",
																													worktreePath: wt.path,
																												});
																											}}
																										>
																											<GitMerge className="size-4" />
																											Merge
																										</ContextMenu.Item>
																									)}
																									{wt.branch &&
																										remoteUrls[directory] && (
																											<ContextMenu.Item
																												className={
																													CTX_ITEM_CLASS
																												}
																												onSelect={() => {
																													const remote =
																														remoteUrls[
																															directory
																														];
																													if (!remote) return;
																													const url =
																														buildPRUrl(
																															remote,
																															wt.branch ?? "",
																														);
																													if (url) {
																														openExternalLink(
																															url,
																														);
																													}
																												}}
																											>
																												<ExternalLink className="size-4" />
																												Open pull request
																											</ContextMenu.Item>
																										)}
																									<ContextMenu.Separator
																										className={
																											CTX_SEPARATOR_CLASS
																										}
																									/>
																									<ContextMenu.Item
																										className={`${CTX_ITEM_CLASS} text-destructive focus:text-destructive`}
																										onSelect={async () => {
																											// Remove from OpenGUI first
																											if (
																												worktreeDirs.has(
																													wt.path,
																												)
																											) {
																												unregisterWorktree(
																													wt.path,
																												);
																												await removeProject(
																													wt.path,
																												);
																											}
																											// Then remove the git worktree
																											await window.electronAPI?.git?.removeWorktree(
																												directory,
																												wt.path,
																											);
																											void refreshGitInfo(
																												directory,
																											);
																										}}
																									>
																										Remove
																									</ContextMenu.Item>
																								</ContextMenu.SubContent>
																							</ContextMenu.Portal>
																						</ContextMenu.Sub>
																					))}
																			</ContextMenu.SubContent>
																		</ContextMenu.Portal>
																	</ContextMenu.Sub>
																)}
															</>
														)}
													</ContextMenu.Content>
												</ContextMenu.Portal>
											</ContextMenu.Root>
										</SidebarMenu>

										{/* Sessions under this project */}
										{!isCollapsed && sidebarState !== "collapsed" && (
											<SidebarMenu className="ml-3 border-l border-sidebar-border pl-2 w-[calc(100%-0.75rem)] overflow-x-hidden">
												{dirSessions.length === 0 ? (
													<div className="px-2 py-1 text-[11px] text-muted-foreground">
														No sessions yet
													</div>
												) : (
													<>
														{visibleSessions.map((session) => {
															const isActive = session.id === activeSessionId;
															const isBusy = busySessionIds.has(session.id);
															const isUnread = unreadSessionIds.has(session.id);
															const hasUnsent = hasUnsentDraft(session.id);
															const queueCount = (
																queuedPrompts[session.id] ?? []
															).length;
															const hasQuestion =
																!!pendingQuestions[session.id];
															const hasPermission =
																!!pendingPermissions[session.id];
															const meta = sessionMeta[session.id];
															const hasColor = !!meta?.color;
															const colorBorderClass = hasColor
																? `border-l-[3px] -ml-[3px] ${getColorBorderClass(meta.color)}`
																: "";
															const tags = meta?.tags ?? [];
															const isWorktreeSession =
																session.directory !== directory &&
																worktreeParents[session.directory]
																	?.parentDir === directory;
															const worktreeBranch = isWorktreeSession
																? getProjectName(session.directory)
																: null;
															return (
																<SessionContextMenu
																	key={session.id}
																	currentColor={meta?.color}
																	currentTags={tags}
																	onSetColor={(color) =>
																		setSessionColor(session.id, color)
																	}
																	onSetTags={(newTags) =>
																		setSessionTags(session.id, newTags)
																	}
																	onRename={() =>
																		startEditing(
																			session.id,
																			session.title || "",
																		)
																	}
																	onDelete={() => deleteSession(session.id)}
																>
																	<SidebarMenuItem>
																		<Tooltip>
																			<TooltipTrigger asChild>
																				<SidebarMenuButton
																					tooltip={session.title}
																					isActive={isActive}
																					onClick={() => {
																						if (editingSessionId === session.id)
																							return;
																						void selectSession(session.id);
																					}}
																					className={`group/session min-w-0 ${colorBorderClass}`}
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
																							onChange={(e) =>
																								setEditValue(e.target.value)
																							}
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
																							onClick={(e) =>
																								e.stopPropagation()
																							}
																							onDoubleClick={(e) =>
																								e.stopPropagation()
																							}
																							// biome-ignore lint/a11y/noAutofocus: intentional for inline rename
																							autoFocus
																							className="min-w-0 flex-1 truncate bg-transparent outline-none text-sm border-b border-primary"
																						/>
																					) : (
																						// biome-ignore lint/a11y/useSemanticElements: double-click rename trigger on session title
																						<span
																							role="textbox"
																							tabIndex={-1}
																							className={`truncate min-w-0 flex-1 ${isUnread ? "font-semibold" : ""}`}
																							onDoubleClick={(e) => {
																								e.stopPropagation();
																								startEditing(
																									session.id,
																									session.title || "",
																								);
																							}}
																						>
																							{session.title || "Untitled"}
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
																								<span className="text-[9px] text-muted-foreground">
																									+{tags.length - 2}
																								</span>
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
																					{/* biome-ignore lint/a11y/useSemanticElements: nested inside SidebarMenuButton (already a <button>) */}
																					<div
																						role="button"
																						tabIndex={0}
																						className="ml-auto opacity-0 group-hover/session:opacity-100 transition-opacity shrink-0 size-6 rounded-md flex items-center justify-center hover:bg-accent"
																						onClick={(e) => {
																							e.stopPropagation();
																							void deleteSession(session.id);
																						}}
																						onKeyDown={(e) => {
																							if (
																								e.key === "Enter" ||
																								e.key === " "
																							) {
																								e.stopPropagation();
																								void deleteSession(session.id);
																							}
																						}}
																					>
																						<Trash2 className="size-3" />
																					</div>
																				</SidebarMenuButton>
																			</TooltipTrigger>
																			<TooltipContent
																				side="right"
																				align="center"
																				hidden={editingSessionId === session.id}
																			>
																				{session.title || "Untitled"}
																			</TooltipContent>
																		</Tooltip>
																	</SidebarMenuItem>
																</SessionContextMenu>
															);
														})}
														{hasMoreSessions && (
															<SidebarMenuItem>
																<SidebarMenuButton
																	onClick={() => {
																		setVisibleByProject((prev) => ({
																			...prev,
																			[directory]:
																				(prev[directory] ?? SESSION_PAGE_SIZE) +
																				SESSION_PAGE_SIZE,
																		}));
																	}}
																	className="text-muted-foreground min-w-0"
																>
																	<ChevronDown className="shrink-0" />
																	<span className="truncate">
																		Load more (
																		{dirSessions.length - visibleCount})
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
																	<span className="truncate">Show less</span>
																</SidebarMenuButton>
															</SidebarMenuItem>
														)}
													</>
												)}
											</SidebarMenu>
										)}
									</div>
								);
							})}
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
							<div className="ml-auto text-xs text-muted-foreground">
								{popoverSessions.length}
							</div>
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
									<span className="truncate">New session</span>
								</button>
							</li>
							{popoverSessions.length === 0 ? (
								<div className="px-2 py-2 text-xs text-muted-foreground">
									No sessions yet
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

									return (
										<li key={session.id}>
											<button
												type="button"
												onClick={() => {
													void selectSession(session.id);
													setProjectPopover(null);
												}}
												className={`text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm min-w-0 ${
													isActive
														? "bg-sidebar-accent text-sidebar-accent-foreground"
														: ""
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
												<span
													className={`truncate min-w-0 flex-1 ${isUnread ? "font-semibold" : ""}`}
												>
													{session.title || "Untitled"}
												</span>
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

				{/* Empty state when no projects at all */}
				{projectGroups.size === 0 && (
					<div className="px-4 py-8 text-center text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
						{detachedProject ? (
							<>
								<p>Project not connected</p>
								<p className="mt-1 truncate">
									{abbreviatePath(detachedProject, homeDir)}
								</p>
							</>
						) : (
							<>
								<p>No projects connected</p>
								<p className="mt-1">
									Click the{" "}
									<Settings className="inline size-3 align-text-bottom" /> icon
									below to start the server and add a project.
								</p>
							</>
						)}
					</div>
				)}
			</SidebarContent>

			{!detachedProject && (
				<SidebarFooter className="border-t border-sidebar-border">
					<ConnectionPanel />
				</SidebarFooter>
			)}

			<SidebarRail />

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
