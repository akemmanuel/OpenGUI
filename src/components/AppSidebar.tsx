import {
	BadgeQuestionMark,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	CirclePlus,
	Copy,
	FolderOpen,
	MessageSquare,
	Settings,
	ShieldAlert,
	SquarePen,
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
import { hasAnyConnection, useOpenCode } from "@/hooks/use-opencode";
import { abbreviatePath } from "@/lib/utils";
import logoDark from "../../opencode-logo-dark.svg";
import logoLight from "../../opencode-logo-light.svg";
import openguiLogoDark from "../../opengui-dark.svg";
import openguiLogoLight from "../../opengui-light.svg";
import { ConnectionPanel } from "./ConnectionPanel";
import { getColorBorderClass, SessionContextMenu } from "./SessionContextMenu";

const SESSION_PAGE_SIZE = 12;

/** Get just the last segment as a short project name. */
function projectName(directory: string): string {
	const parts = directory.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || directory;
}

export function AppSidebar() {
	const { state: sidebarState } = useSidebar();
	const {
		state,
		selectSession,
		startDraftSession,
		deleteSession,
		removeProject,
		openDirectory,
		connectToProject,
		setSessionColor,
		setSessionTags,
	} = useOpenCode();
	const {
		sessions,
		activeSessionId,
		connections,
		busySessionIds,
		queuedPrompts,
		pendingQuestions,
		pendingPermissions,
		temporarySessions,
		unreadSessionIds,
		sessionMeta,
	} = state;

	const isConnected = hasAnyConnection(connections);

	const [homeDir, setHomeDir] = useState("");
	useEffect(() => {
		window.electronAPI?.getHomeDir?.().then((d) => setHomeDir(d ?? ""));
	}, []);

	// Group root sessions by directory
	const projectGroups = useMemo(() => {
		const openDirectories = Object.keys(connections);
		const rootSessions = sessions.filter(
			(s) =>
				!s.parentID &&
				openDirectories.includes(s.directory) &&
				!temporarySessions.has(s.id),
		);
		const groups = new Map<string, typeof rootSessions>();
		for (const dir of openDirectories) {
			groups.set(dir, []);
		}
		for (const s of rootSessions) {
			const dir = s.directory;
			if (!groups.has(dir)) groups.set(dir, []);
			groups.get(dir)?.push(s);
		}
		return groups;
	}, [sessions, connections, temporarySessions]);

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

	useEffect(() => {
		if (!projectPopover) return;

		const onPointerDown = (event: MouseEvent) => {
			const target = event.target as Node;
			if (popoverRef.current?.contains(target)) return;
			setProjectPopover(null);
		};

		const onEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setProjectPopover(null);
		};

		window.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onEscape);
		return () => {
			window.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onEscape);
		};
	}, [projectPopover]);

	const popoverSessions = projectPopover
		? (projectGroups.get(projectPopover.directory) ?? [])
		: [];

	return (
		<Sidebar collapsible="icon" className="select-none relative">
			<SidebarHeader className="border-b border-sidebar-border p-0 gap-0 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:gap-2">
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
				<div className="hidden border-b border-sidebar-border -mx-2 group-data-[collapsible=icon]:block" />
				{/* Add project button */}
				{isConnected && (
					<SidebarMenu className="p-2 group-data-[collapsible=icon]:p-0">
						<SidebarMenuItem>
							<SidebarMenuButton
								tooltip="Open project"
								onClick={async () => {
									const dir = await openDirectory();
									if (dir) connectToProject(dir);
								}}
							>
								<FolderOpen />
								<span>Open project</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				)}
			</SidebarHeader>

			<SidebarContent className="overflow-x-hidden">
				{/* Project groups */}
				{projectGroups.size > 0 && (
					<SidebarGroup>
						<SidebarGroupLabel>Your projects</SidebarGroupLabel>
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
											<ContextMenu.Root>
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
															) : (
																<ChevronRight
																	className={`shrink-0 size-4 transition-transform ${
																		!isCollapsed ? "rotate-90" : ""
																	}`}
																/>
															)}
															<span className="truncate min-w-0 flex-1">
																{projectName(directory)}
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
															{/* Remove project */}
															{/* biome-ignore lint/a11y/useSemanticElements: nested inside SidebarMenuButton (already a <button>) */}
															<div
																role="button"
																tabIndex={0}
																className="opacity-0 group-hover/project:opacity-100 transition-opacity shrink-0 size-6 rounded-md flex items-center justify-center hover:bg-accent group-data-[collapsible=icon]:hidden"
																onClick={(e) => {
																	e.stopPropagation();
																	removeProject(directory);
																}}
																onKeyDown={(e) => {
																	if (e.key === "Enter" || e.key === " ") {
																		e.stopPropagation();
																		removeProject(directory);
																	}
																}}
															>
																<X className="size-3" />
															</div>
														</SidebarMenuButton>
													</SidebarMenuItem>
												</ContextMenu.Trigger>
												<ContextMenu.Portal>
													<ContextMenu.Content
														className="z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
														alignOffset={5}
													>
														<ContextMenu.Item
															className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
															onSelect={() => {
																navigator.clipboard.writeText(directory);
															}}
														>
															<Copy className="size-4" />
															<span>Copy absolute path</span>
														</ContextMenu.Item>
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
																	onDelete={() => deleteSession(session.id)}
																>
																	<SidebarMenuItem>
																		<SidebarMenuButton
																			tooltip={session.title}
																			isActive={isActive}
																			onClick={() => selectSession(session.id)}
																			className={`group/session min-w-0 ${colorBorderClass}`}
																		>
																			<span className="relative shrink-0">
																				{isBusy ? (
																					<Spinner className="size-4 text-muted-foreground" />
																				) : (
																					<MessageSquare className="size-4" />
																				)}
																				{isUnread && !isBusy && (
																					<span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" />
																				)}
																			</span>
																			<span
																				className={`truncate min-w-0 flex-1 ${isUnread ? "font-semibold" : ""}`}
																			>
																				{session.title || "Untitled"}
																			</span>
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
																					deleteSession(session.id);
																				}}
																				onKeyDown={(e) => {
																					if (
																						e.key === "Enter" ||
																						e.key === " "
																					) {
																						e.stopPropagation();
																						deleteSession(session.id);
																					}
																				}}
																			>
																				<Trash2 className="size-3" />
																			</div>
																		</SidebarMenuButton>
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
								{projectName(projectPopover.directory)}
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
									const queueCount = (queuedPrompts[session.id] ?? []).length;
									const hasQuestion = !!pendingQuestions[session.id];
									const hasPermission = !!pendingPermissions[session.id];

									return (
										<li key={session.id}>
											<button
												type="button"
												onClick={() => {
													selectSession(session.id);
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
						<p>No projects connected</p>
						<p className="mt-1">
							Click the <Settings className="inline size-3 align-text-bottom" />{" "}
							icon below to start the server and add a project.
						</p>
					</div>
				)}
			</SidebarContent>

			<SidebarFooter className="border-t border-sidebar-border">
				<ConnectionPanel />
			</SidebarFooter>

			<SidebarRail />
		</Sidebar>
	);
}
