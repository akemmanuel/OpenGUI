import {
	ArrowDownToLine,
	ArrowUpToLine,
	Ellipsis,
	GripVertical,
	Pencil,
	Send,
	Trash2,
} from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface QueueItem {
	id: string;
	text: string;
	variant?: string;
	agent?: string;
	mode?: string;
}

interface QueueListProps {
	items: QueueItem[];
	onRemove?: (id: string) => void;
	onMoveUp?: (index: number) => void;
	onMoveDown?: (index: number) => void;
	onMoveToTop?: (index: number) => void;
	onMoveToBottom?: (index: number) => void;
	onEdit?: (id: string, newText: string) => void;
	onSendNow?: (id: string) => void;
	onReorder?: (fromIndex: number, toIndex: number) => void;
}

function QueueItemRow({
	item,
	index,
	total,
	onRemove,
	onMoveUp: _onMoveUp,
	onMoveDown: _onMoveDown,
	onMoveToTop,
	onMoveToBottom,
	onEdit,
	onSendNow,
}: {
	item: QueueItem;
	index: number;
	total: number;
	onRemove?: (id: string) => void;
	onMoveUp?: (index: number) => void;
	onMoveDown?: (index: number) => void;
	onMoveToTop?: (index: number) => void;
	onMoveToBottom?: (index: number) => void;
	onEdit?: (id: string, newText: string) => void;
	onSendNow?: (id: string) => void;
}) {
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [editing, setEditing] = React.useState(false);
	const [editValue, setEditValue] = React.useState(item.text);
	const menuRef = React.useRef<HTMLDivElement>(null);
	const buttonRef = React.useRef<HTMLButtonElement>(null);
	const rowRef = React.useRef<HTMLDivElement>(null);

	const isFirst = index === 0;
	const isLast = index === total - 1;

	// Close menu on outside click
	React.useEffect(() => {
		if (!menuOpen) return;
		const handler = (e: MouseEvent) => {
			if (
				menuRef.current &&
				!menuRef.current.contains(e.target as Node) &&
				buttonRef.current &&
				!buttonRef.current.contains(e.target as Node)
			) {
				setMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [menuOpen]);

	// Position menu - render below first, then adjust if needed
	const [menuCoords, setMenuCoords] = React.useState<{ top: number; left: number }>({ top: 0, left: 0 });
	React.useEffect(() => {
		if (!menuOpen || !buttonRef.current) return;
		const button = buttonRef.current.getBoundingClientRect();
		const top = button.bottom + 8;
		const left = button.right - 160;
		setMenuCoords({ top, left });
		requestAnimationFrame(() => {
			if (!menuRef.current || !buttonRef.current) return;
			const button = buttonRef.current.getBoundingClientRect();
			const menu = menuRef.current.getBoundingClientRect();
			const padding = 8;
			const menuHeight = menu.height;
			const menuWidth = menu.width;
			const spaceBelow = window.innerHeight - button.bottom;
			const spaceAbove = button.top;
			let newTop: number;
			if (spaceBelow >= menuHeight + padding || spaceBelow >= spaceAbove) {
				newTop = button.bottom + padding;
			} else if (spaceAbove >= menuHeight + padding) {
				newTop = button.top - menuHeight - padding;
			} else {
				newTop = button.bottom + padding;
			}
			let newLeft = button.right - menuWidth;
			if (newLeft < padding) newLeft = padding;
			if (newLeft + menuWidth > window.innerWidth - padding) {
				newLeft = window.innerWidth - menuWidth - padding;
			}
			setMenuCoords({ top: newTop, left: newLeft });
		});
	}, [menuOpen]);

	const handleEditSave = () => {
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== item.text) {
			onEdit?.(item.id, trimmed);
		}
		setEditing(false);
	};

	return (
		<div
			ref={rowRef}
			className={cn(
				"group flex items-center gap-1 px-2 py-1 rounded-md",
				"hover:bg-accent/50 transition-colors",
			)}
		>
			<div
				className="size-3.5 text-muted-foreground/50 shrink-0"
			>
				<GripVertical className="size-3.5" />
			</div>

			{editing ? (
				<input
					type="text"
					value={editValue}
					onChange={(e) => setEditValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") handleEditSave();
						if (e.key === "Escape") {
							setEditValue(item.text);
							setEditing(false);
						}
					}}
					onBlur={handleEditSave}
					className="flex-1 min-w-0 bg-transparent border border-border rounded px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
					// biome-ignore lint/a11y/noAutofocus: editing mode requires immediate focus
					autoFocus
				/>
			) : (
				<span className="flex-1 min-w-0 truncate text-xs text-foreground/80">
					{item.text}
				</span>
			)}

			{/* Show snapshotted variant / agent / mode badges */}
			{(item.variant || item.agent || (item.mode && item.mode !== "queue")) &&
				!editing && (
					<span className="shrink-0 flex items-center gap-1 text-[10px] text-muted-foreground">
						{item.mode && item.mode !== "queue" && (
							<span
								className={cn(
									"rounded px-1 py-px",
									item.mode === "interrupt"
										? "bg-destructive/15 text-destructive"
										: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
								)}
							>
								{item.mode === "interrupt" ? "interrupt" : "steer"}
							</span>
						)}
						{item.variant && (
							<span className="rounded bg-muted px-1 py-px capitalize">
								{item.variant}
							</span>
						)}
						{item.agent && (
							<span className="rounded bg-muted px-1 py-px">{item.agent}</span>
						)}
					</span>
				)}

			{!editing && (
				<div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0">
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						onClick={(e) => {
							e.stopPropagation();
							onSendNow?.(item.id);
						}}
						className="text-muted-foreground hover:text-foreground"
						title="Send now"
					>
						<Send className="size-3" />
					</Button>

					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						onClick={(e) => {
							e.stopPropagation();
							onRemove?.(item.id);
						}}
						className="text-muted-foreground hover:text-destructive"
					>
						<Trash2 className="size-3" />
					</Button>

					<div className="relative">
						<Button
							ref={buttonRef}
							type="button"
							variant="ghost"
							size="icon-xs"
							onClick={(e) => {
								e.stopPropagation();
								setMenuOpen((v) => !v);
							}}
							className="text-muted-foreground hover:text-foreground"
						>
							<Ellipsis className="size-3" />
						</Button>

						{menuOpen && (
							<div
								ref={menuRef}
								className="fixed z-50 min-w-[140px] rounded-md border bg-popover p-1 shadow-md"
								style={{ top: menuCoords.top, left: menuCoords.left }}
							>
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-xs hover:bg-accent transition-colors text-left"
									onClick={() => {
										setMenuOpen(false);
										setMenuCoords({ top: 0, left: 0 });
										setEditValue(item.text);
										setEditing(true);
									}}
								>
									<Pencil className="size-3" />
									Edit
								</button>
								{!isFirst && (
									<button
										type="button"
										className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-xs hover:bg-accent transition-colors text-left"
										onClick={() => {
											setMenuOpen(false);
											setMenuCoords({ top: 0, left: 0 });
											onMoveToTop?.(index);
										}}
									>
										<ArrowUpToLine className="size-3" />
										Move to top
									</button>
								)}
								{!isLast && (
									<button
										type="button"
										className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-xs hover:bg-accent transition-colors text-left"
										onClick={() => {
											setMenuOpen(false);
											setMenuCoords({ top: 0, left: 0 });
											onMoveToBottom?.(index);
										}}
									>
										<ArrowDownToLine className="size-3" />
										Move to bottom
									</button>
								)}
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

export function QueueList({
	items,
	onRemove,
	onMoveUp,
	onMoveDown,
	onMoveToTop,
	onMoveToBottom,
	onEdit,
	onSendNow,
	onReorder,
}: QueueListProps) {
	const [dragOverIndex, setDragOverIndex] = React.useState<number | null>(null);

	if (items.length === 0) return null;

	const handleDragOver = (e: React.DragEvent, index: number) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		setDragOverIndex(index);
	};

	const handleDrop = (e: React.DragEvent, toIndex: number) => {
		e.preventDefault();
		const fromIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
		if (!isNaN(fromIndex) && fromIndex !== toIndex) {
			onReorder?.(fromIndex, toIndex);
		}
	};

	const handleDragEnd = () => {
		setDragOverIndex(null);
	};

	return (
		<div className="rounded-xl border bg-background shadow-xs">
			<div className="flex flex-col max-h-[216px] overflow-y-auto">
				<div
					onDragEnter={() => setDragOverIndex(0)}
					onDragOver={(e) => {
						e.preventDefault();
						e.dataTransfer.dropEffect = "move";
						setDragOverIndex(0);
					}}
					onDrop={(e) => {
						e.preventDefault();
						const fromIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
						if (!isNaN(fromIndex) && fromIndex !== 0) {
							onReorder?.(fromIndex, 0);
						}
						setDragOverIndex(null);
					}}
					onDragLeave={() => setDragOverIndex(null)}
					onDragEnd={handleDragEnd}
					className={cn(
						"h-1 -mb-1",
						dragOverIndex === 0 && "border-t-2 border-primary",
					)}
				/>
				{items.map((item, idx) => (
					<div
						key={item.id}
						draggable
						onDragStart={(e) => {
							e.dataTransfer.setData("text/plain", String(idx));
							e.dataTransfer.effectAllowed = "move";
						}}
						onDragOver={(e) => handleDragOver(e, idx)}
						onDrop={(e) => handleDrop(e, idx)}
						onDragEnd={handleDragEnd}
						className={cn(
							"cursor-move",
							dragOverIndex === idx + 1 && "border-b-2 border-primary",
						)}
					>
						<QueueItemRow
							item={item}
							index={idx}
							total={items.length}
							onRemove={onRemove}
							onMoveUp={onMoveUp}
							onMoveDown={onMoveDown}
							onMoveToTop={onMoveToTop}
							onMoveToBottom={onMoveToBottom}
							onEdit={onEdit}
							onSendNow={onSendNow}
						/>
					</div>
				))}
				<div
					draggable
					onDragEnter={() => setDragOverIndex(items.length)}
					onDragOver={(e) => {
						e.preventDefault();
						e.dataTransfer.dropEffect = "move";
						setDragOverIndex(items.length);
					}}
					onDrop={(e) => {
						e.preventDefault();
						const fromIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
						if (!isNaN(fromIndex)) {
							onReorder?.(fromIndex, items.length - 1);
						}
						setDragOverIndex(null);
					}}
					onDragLeave={() => setDragOverIndex(null)}
					onDragEnd={handleDragEnd}
					className={cn(
						"h-1 -mt-1",
						dragOverIndex === items.length && "border-b-2 border-primary",
					)}
				/>
			</div>
		</div>
	);
}
