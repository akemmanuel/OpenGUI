import { Check, Copy, FolderOpen, GitBranch, GitMerge, MoreHorizontal, Palette, Pencil, Pin, PinOff, SquarePen, Tag, Terminal, Trash2, X, ExternalLink } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useCallback, useRef, useState } from "react";
import { ContextMenu } from "radix-ui";
import type { SessionColor } from "@/hooks/use-agent-state";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet } from "@/lib/safe-storage";
import { formatTimeAgo, getProjectName } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SESSION_COLORS: {
	value: SessionColor;
	label: string;
	className: string;
}[] = [
	{ value: null, label: "None", className: "bg-transparent border border-muted-foreground/30" },
	{ value: "red", label: "Red", className: "bg-red-500" },
	{ value: "orange", label: "Orange", className: "bg-orange-500" },
	{ value: "yellow", label: "Yellow", className: "bg-yellow-500" },
	{ value: "green", label: "Green", className: "bg-green-500" },
	{ value: "blue", label: "Blue", className: "bg-blue-500" },
	{ value: "purple", label: "Purple", className: "bg-purple-500" },
	{ value: "pink", label: "Pink", className: "bg-pink-500" },
	{ value: "gray", label: "Gray", className: "bg-gray-500" },
];

export function SessionItemMenu({
	pinned,
	currentColor,
	currentTags,
	onTogglePin,
	onSetColor,
	onSetTags,
	onRename,
	onDelete,
}: {
	pinned: boolean;
	currentColor: SessionColor | undefined;
	currentTags: string[];
	onTogglePin: () => void;
	onSetColor: (color: SessionColor) => void;
	onSetTags: (tags: string[]) => void;
	onRename: () => void;
	onDelete: () => void;
}) {
	const [tagInput, setTagInput] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const handleAddTag = useCallback(() => {
		const trimmed = tagInput.trim();
		if (trimmed && !currentTags.includes(trimmed)) onSetTags([...currentTags, trimmed]);
		setTagInput("");
	}, [tagInput, currentTags, onSetTags]);
	const handleTagKeyDown = useCallback(
		(event: KeyboardEvent<HTMLInputElement>) => {
			event.stopPropagation();
			if (event.key === "Enter") {
				event.preventDefault();
				handleAddTag();
			}
		},
		[handleAddTag],
	);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={pinned ? "Unpin session" : "Pin session"}
					className="ml-auto opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100 transition-opacity shrink-0 size-6 rounded-md flex items-center justify-center hover:bg-accent"
					onClick={(event) => event.stopPropagation()}
				>
					<MoreHorizontal className="size-3.5" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
				<DropdownMenuItem onClick={(event) => {
					event.stopPropagation();
					onTogglePin();
				}}>
					{pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
					<span>{pinned ? "Unpin" : "Pin to top"}</span>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={(event) => {
					event.stopPropagation();
					onRename();
				}}>
					<Pencil className="size-4" />
					<span>Rename</span>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<Palette className="size-4" />
						<span>Set color</span>
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						{SESSION_COLORS.map((color) => (
							<DropdownMenuItem
								key={color.value ?? "none"}
								onClick={(event) => {
									event.stopPropagation();
									onSetColor(color.value);
								}}
							>
								<span className={cn("size-3 rounded-full shrink-0", color.className)} />
								<span>{color.label}</span>
								{(currentColor ?? null) === color.value && <Check className="ml-auto size-3.5" />}
							</DropdownMenuItem>
						))}
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				<DropdownMenuSub onOpenChange={(open) => {
					if (open) setTimeout(() => inputRef.current?.focus(), 0);
					else setTagInput("");
				}}>
					<DropdownMenuSubTrigger>
						<Tag className="size-4" />
						<span>Tags</span>
						{currentTags.length > 0 && <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{currentTags.length}</span>}
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="min-w-[12rem] max-w-[16rem]">
						{currentTags.length > 0 && (
							<>
								<div className="flex flex-wrap gap-1 px-2 py-1.5">
									{currentTags.map((tag) => (
										<span key={tag} className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
											{tag}
											<button
												type="button"
												className="ml-0.5 rounded-full hover:bg-accent p-0.5"
												onClick={(event) => {
													event.stopPropagation();
													onSetTags(currentTags.filter((currentTag) => currentTag !== tag));
												}}
											>
												<X className="size-2.5" />
											</button>
										</span>
									))}
								</div>
								<DropdownMenuSeparator />
							</>
						)}
						<div className="px-2 py-1.5">
							<input
								ref={inputRef}
								type="text"
								value={tagInput}
								onChange={(event) => setTagInput(event.target.value)}
								onKeyDown={handleTagKeyDown}
								placeholder="Add tag..."
								className="h-7 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[2px]"
							/>
						</div>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive" onClick={(event) => {
					event.stopPropagation();
					onDelete();
				}}>
					<Trash2 className="size-4" />
					<span>Delete session</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

type ProjectMenuWorktree = { path: string; branch?: string | null };

type ProjectMenuContentProps = {
	kind: "dropdown" | "context";
	pinned: boolean;
	canCreateSession: boolean;
	onTogglePin: () => void;
	onNewSession: () => void;
	canRemove: boolean;
	onRemove: () => void;
	directory: string;
	isLocalWorkspace: boolean;
	isGitRepo: boolean;
	worktrees: ProjectMenuWorktree[];
	worktreeParents: Record<string, { createdAt: string; parentDir?: string } | undefined>;
	onNewWorktree: () => void;
	onMergeWorktree: (worktree: ProjectMenuWorktree) => void;
	onOpenWorktreePr: (worktree: ProjectMenuWorktree) => void;
	onRemoveWorktree: (worktree: ProjectMenuWorktree) => void | Promise<void>;
};

export function ProjectMenuContent({
	kind,
	pinned,
	canCreateSession,
	onTogglePin,
	onNewSession,
	canRemove,
	onRemove,
	directory,
	isLocalWorkspace,
	isGitRepo,
	worktrees,
	worktreeParents,
	onNewWorktree,
	onMergeWorktree,
	onOpenWorktreePr,
	onRemoveWorktree,
}: ProjectMenuContentProps) {
	const extraWorktrees = worktrees.filter((worktree) => worktree.path !== directory);

	if (kind === "dropdown") {
		return (
			<>
				<DropdownMenuItem onClick={(event) => {
					event.stopPropagation();
					onTogglePin();
				}}>
					{pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
					<span>{pinned ? "Unpin" : "Pin to top"}</span>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={(event) => {
					event.stopPropagation();
					void navigator.clipboard.writeText(directory);
				}}>
					<Copy className="size-4" />
					<span>Copy absolute path</span>
				</DropdownMenuItem>
				{isLocalWorkspace && (
					<>
						<DropdownMenuItem onClick={(event) => {
							event.stopPropagation();
							void window.electronAPI?.openInFileBrowser(directory, storageGet(STORAGE_KEYS.FILE_MANAGER) ?? "");
						}}>
							<FolderOpen className="size-4" />
							<span>Open in file browser</span>
						</DropdownMenuItem>
						<DropdownMenuItem onClick={(event) => {
							event.stopPropagation();
							void window.electronAPI?.openInTerminal(directory, storageGet(STORAGE_KEYS.TERMINAL) ?? "");
						}}>
							<Terminal className="size-4" />
							<span>Open in terminal</span>
						</DropdownMenuItem>
					</>
				)}
				{canCreateSession && (
					<DropdownMenuItem onClick={(event) => {
						event.stopPropagation();
						onNewSession();
					}}>
						<SquarePen className="size-4" />
						<span>New session</span>
					</DropdownMenuItem>
				)}
				{isLocalWorkspace && isGitRepo && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={(event) => {
							event.stopPropagation();
							onNewWorktree();
						}}>
							<GitBranch className="size-4" />
							<span>New worktree...</span>
						</DropdownMenuItem>
						{extraWorktrees.length > 0 && (
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>
									<GitBranch className="size-4" />
									<span>Worktrees</span>
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent>
									{extraWorktrees.map((worktree) => {
										const worktreeMeta = worktreeParents[worktree.path];
										return (
											<DropdownMenuSub key={worktree.path}>
												<DropdownMenuSubTrigger>
													<div className="flex flex-col truncate">
														<span className="truncate">{worktree.branch ?? getProjectName(worktree.path)}</span>
														{worktreeMeta && (
															<span className="text-[10px] text-muted-foreground">{formatTimeAgo(worktreeMeta.createdAt)}</span>
														)}
													</div>
												</DropdownMenuSubTrigger>
												<DropdownMenuSubContent>
													{worktree.branch && (
														<DropdownMenuItem onClick={(event) => {
															event.stopPropagation();
															onMergeWorktree(worktree);
														}}>
															<GitMerge className="size-4" />
															Merge
														</DropdownMenuItem>
													)}
													{worktree.branch && (
														<DropdownMenuItem onClick={(event) => {
															event.stopPropagation();
															onOpenWorktreePr(worktree);
														}}>
															<ExternalLink className="size-4" />
															Open pull request
														</DropdownMenuItem>
													)}
													<DropdownMenuSeparator />
													<DropdownMenuItem variant="destructive" onClick={(event) => {
														event.stopPropagation();
														void onRemoveWorktree(worktree);
													}}>
														Remove
													</DropdownMenuItem>
												</DropdownMenuSubContent>
											</DropdownMenuSub>
										);
									})}
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						)}
					</>
				)}
				{canRemove && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" onClick={(event) => {
							event.stopPropagation();
							onRemove();
						}}>
							<X className="size-4" />
							<span>Remove project</span>
						</DropdownMenuItem>
					</>
				)}
			</>
		);
	}

	return (
		<>
			<ContextMenu.Item className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground" onSelect={onTogglePin}>
				{pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
				<span>{pinned ? "Unpin" : "Pin to top"}</span>
			</ContextMenu.Item>
			<ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
			<ContextMenu.Item className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground" onSelect={() => {
				void navigator.clipboard.writeText(directory);
			}}>
				<Copy className="size-4" />
				<span>Copy absolute path</span>
			</ContextMenu.Item>
			{isLocalWorkspace && (
				<>
					<ContextMenu.Item className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground" onSelect={() => {
						void window.electronAPI?.openInFileBrowser(directory, storageGet(STORAGE_KEYS.FILE_MANAGER) ?? "");
					}}>
						<FolderOpen className="size-4" />
						<span>Open in file browser</span>
					</ContextMenu.Item>
					<ContextMenu.Item className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground" onSelect={() => {
						void window.electronAPI?.openInTerminal(directory, storageGet(STORAGE_KEYS.TERMINAL) ?? "");
					}}>
						<Terminal className="size-4" />
						<span>Open in terminal</span>
					</ContextMenu.Item>
				</>
			)}
			{canCreateSession && (
				<ContextMenu.Item className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground" onSelect={onNewSession}>
					<SquarePen className="size-4" />
					<span>New session</span>
				</ContextMenu.Item>
			)}
			{isLocalWorkspace && isGitRepo && (
				<>
					<ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
					<ContextMenu.Item className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground" onSelect={onNewWorktree}>
						<GitBranch className="size-4" />
						<span>New worktree...</span>
					</ContextMenu.Item>
					{extraWorktrees.length > 0 && (
						<ContextMenu.Sub>
							<ContextMenu.SubTrigger className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent">
								<GitBranch className="size-4" />
								<span>Worktrees</span>
							</ContextMenu.SubTrigger>
							<ContextMenu.Portal>
								<ContextMenu.SubContent className="z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95" sideOffset={4}>
									{extraWorktrees.map((worktree) => {
										const worktreeMeta = worktreeParents[worktree.path];
										return (
											<ContextMenu.Sub key={worktree.path}>
												<ContextMenu.SubTrigger className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent">
													<div className="flex flex-col truncate">
														<span className="truncate">{worktree.branch ?? getProjectName(worktree.path)}</span>
														{worktreeMeta && (
															<span className="text-[10px] text-muted-foreground">{formatTimeAgo(worktreeMeta.createdAt)}</span>
														)}
													</div>
												</ContextMenu.SubTrigger>
												<ContextMenu.Portal>
													<ContextMenu.SubContent className="z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95" sideOffset={4}>
														{worktree.branch && (
															<ContextMenu.Item className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground" onSelect={() => onMergeWorktree(worktree)}>
																<GitMerge className="size-4" />
																Merge
															</ContextMenu.Item>
														)}
														{worktree.branch && (
															<ContextMenu.Item className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground" onSelect={() => onOpenWorktreePr(worktree)}>
																<ExternalLink className="size-4" />
																Open pull request
															</ContextMenu.Item>
														)}
														<ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
														<ContextMenu.Item className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive outline-none focus:bg-accent focus:text-destructive" onSelect={() => {
															void onRemoveWorktree(worktree);
														}}>
															Remove
														</ContextMenu.Item>
													</ContextMenu.SubContent>
												</ContextMenu.Portal>
											</ContextMenu.Sub>
										);
									})}
								</ContextMenu.SubContent>
							</ContextMenu.Portal>
						</ContextMenu.Sub>
					)}
				</>
			)}
			{canRemove && (
				<>
					<ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
					<ContextMenu.Item className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive outline-none focus:bg-accent focus:text-destructive" onSelect={onRemove}>
						<X className="size-4" />
						<span>Remove project</span>
					</ContextMenu.Item>
				</>
			)}
		</>
	);
}

export function ProjectItemMenu(props: Omit<ProjectMenuContentProps, "kind">) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={props.pinned ? "Unpin project" : "Pin project"}
					className="opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 transition-opacity shrink-0 size-6 rounded-md flex items-center justify-center hover:bg-accent group-data-[collapsible=icon]:hidden"
					data-project-action
					onClick={(event) => event.stopPropagation()}
				>
					<MoreHorizontal className="size-3.5" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<ProjectMenuContent kind="dropdown" {...props} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
