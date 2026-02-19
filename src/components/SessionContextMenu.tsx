import { Check, Palette, Pencil, Tag, Trash2, X } from "lucide-react";
import { ContextMenu } from "radix-ui";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import type { SessionColor } from "@/hooks/use-opencode";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Color config
// ---------------------------------------------------------------------------

export const SESSION_COLORS: {
	value: SessionColor;
	label: string;
	className: string;
	borderClass: string;
}[] = [
	{
		value: null,
		label: "None",
		className: "bg-transparent border border-muted-foreground/30",
		borderClass: "border-sidebar-border",
	},
	{
		value: "red",
		label: "Red",
		className: "bg-red-500",
		borderClass: "border-red-500",
	},
	{
		value: "orange",
		label: "Orange",
		className: "bg-orange-500",
		borderClass: "border-orange-500",
	},
	{
		value: "yellow",
		label: "Yellow",
		className: "bg-yellow-500",
		borderClass: "border-yellow-500",
	},
	{
		value: "green",
		label: "Green",
		className: "bg-green-500",
		borderClass: "border-green-500",
	},
	{
		value: "blue",
		label: "Blue",
		className: "bg-blue-500",
		borderClass: "border-blue-500",
	},
	{
		value: "purple",
		label: "Purple",
		className: "bg-purple-500",
		borderClass: "border-purple-500",
	},
	{
		value: "pink",
		label: "Pink",
		className: "bg-pink-500",
		borderClass: "border-pink-500",
	},
	{
		value: "gray",
		label: "Gray",
		className: "bg-gray-500",
		borderClass: "border-gray-500",
	},
];

/** Look up the border class for a given SessionColor. */
export function getColorBorderClass(color: SessionColor | undefined): string {
	if (!color) return "border-sidebar-border";
	const entry = SESSION_COLORS.find((c) => c.value === color);
	return entry?.borderClass ?? "border-sidebar-border";
}

/** Look up the bg class for tag pills. */
export function getColorBgClass(color: SessionColor | undefined): string {
	if (!color) return "";
	const entry = SESSION_COLORS.find((c) => c.value === color);
	return entry?.className ?? "";
}

// ---------------------------------------------------------------------------
// SessionContextMenu
// ---------------------------------------------------------------------------

interface SessionContextMenuProps {
	children: ReactNode;
	currentColor: SessionColor | undefined;
	currentTags: string[];
	onSetColor: (color: SessionColor) => void;
	onSetTags: (tags: string[]) => void;
	onRename: () => void;
	onDelete: () => void;
}

export function SessionContextMenu({
	children,
	currentColor,
	currentTags,
	onSetColor,
	onSetTags,
	onRename,
	onDelete,
}: SessionContextMenuProps) {
	const [tagInputOpen, setTagInputOpen] = useState(false);
	const [tagInput, setTagInput] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	const handleAddTag = useCallback(() => {
		const trimmed = tagInput.trim();
		if (trimmed && !currentTags.includes(trimmed)) {
			onSetTags([...currentTags, trimmed]);
		}
		setTagInput("");
	}, [tagInput, currentTags, onSetTags]);

	const handleRemoveTag = useCallback(
		(tag: string) => {
			onSetTags(currentTags.filter((t) => t !== tag));
		},
		[currentTags, onSetTags],
	);

	return (
		<ContextMenu.Root
			onOpenChange={(open) => {
				if (!open) {
					setTagInputOpen(false);
					setTagInput("");
				}
			}}
		>
			<ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Content
					className="z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
					alignOffset={5}
					onCloseAutoFocus={(e) => e.preventDefault()}
				>
					{/* Rename */}
					<ContextMenu.Item
						className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
						onSelect={onRename}
					>
						<Pencil className="size-4" />
						<span>Rename</span>
					</ContextMenu.Item>

					<ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />

					{/* Color submenu */}
					<ContextMenu.Sub>
						<ContextMenu.SubTrigger className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent">
							<Palette className="size-4" />
							<span>Set color</span>
						</ContextMenu.SubTrigger>
						<ContextMenu.Portal>
							<ContextMenu.SubContent
								className="z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
								sideOffset={4}
							>
								{SESSION_COLORS.map((c) => (
									<ContextMenu.Item
										key={c.value ?? "none"}
										className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
										onSelect={() => onSetColor(c.value)}
									>
										<span
											className={cn(
												"size-3 rounded-full shrink-0",
												c.className,
											)}
										/>
										<span>{c.label}</span>
										{(currentColor ?? null) === c.value && (
											<Check className="ml-auto size-3.5" />
										)}
									</ContextMenu.Item>
								))}
							</ContextMenu.SubContent>
						</ContextMenu.Portal>
					</ContextMenu.Sub>

					{/* Tags section */}
					<ContextMenu.Sub open={tagInputOpen} onOpenChange={setTagInputOpen}>
						<ContextMenu.SubTrigger className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent">
							<Tag className="size-4" />
							<span>Tags</span>
							{currentTags.length > 0 && (
								<span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
									{currentTags.length}
								</span>
							)}
						</ContextMenu.SubTrigger>
						<ContextMenu.Portal>
							<ContextMenu.SubContent
								className="z-50 min-w-[12rem] max-w-[16rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
								sideOffset={4}
							>
								{/* Existing tags */}
								{currentTags.length > 0 && (
									<>
										<div className="flex flex-wrap gap-1 px-2 py-1.5">
											{currentTags.map((tag) => (
												<span
													key={tag}
													className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
												>
													{tag}
													<button
														type="button"
														className="ml-0.5 rounded-full hover:bg-accent p-0.5"
														onClick={(e) => {
															e.stopPropagation();
															handleRemoveTag(tag);
														}}
													>
														<X className="size-2.5" />
													</button>
												</span>
											))}
										</div>
										<ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
									</>
								)}
								{/* Add new tag */}
								<div className="px-2 py-1.5">
									<div className="flex gap-1">
										<input
											ref={inputRef}
											type="text"
											value={tagInput}
											onChange={(e) => setTagInput(e.target.value)}
											onKeyDown={(e) => {
												e.stopPropagation();
												if (e.key === "Enter") {
													e.preventDefault();
													handleAddTag();
												}
											}}
											placeholder="Add tag..."
											className="h-7 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[2px]"
										/>
									</div>
								</div>
							</ContextMenu.SubContent>
						</ContextMenu.Portal>
					</ContextMenu.Sub>

					<ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />

					{/* Delete */}
					<ContextMenu.Item
						className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground text-destructive focus:text-destructive"
						onSelect={onDelete}
					>
						<Trash2 className="size-4" />
						<span>Delete session</span>
					</ContextMenu.Item>
				</ContextMenu.Content>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
