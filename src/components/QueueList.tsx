import {
	ArrowDown,
	ArrowDownToLine,
	ArrowUp,
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

export interface QueueItem {
	id: string;
	text: string;
	variant?: string;
	agent?: string;
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
}

function QueueItemRow({
	item,
	index,
	total,
	onRemove,
	onMoveUp,
	onMoveDown,
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

	const handleEditSave = () => {
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== item.text) {
			onEdit?.(item.id, trimmed);
		}
		setEditing(false);
	};

	return (
		<div
			className={cn(
				"group flex items-center gap-1.5 px-2 py-1.5 rounded-md",
				"hover:bg-accent/50 transition-colors",
			)}
		>
			<GripVertical className="size-3.5 text-muted-foreground/50 shrink-0 cursor-grab" />

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

			{/* Show snapshotted variant / agent badges */}
			{(item.variant || item.agent) && !editing && (
				<span className="shrink-0 flex items-center gap-1 text-[10px] text-muted-foreground">
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
						disabled={isFirst}
						onClick={(e) => {
							e.stopPropagation();
							onMoveUp?.(index);
						}}
						className="text-muted-foreground hover:text-foreground"
					>
						<ArrowUp className="size-3" />
					</Button>

					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						disabled={isLast}
						onClick={(e) => {
							e.stopPropagation();
							onMoveDown?.(index);
						}}
						className="text-muted-foreground hover:text-foreground"
					>
						<ArrowDown className="size-3" />
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
								className="absolute right-0 bottom-full mb-1 z-50 min-w-[140px] rounded-md border bg-popover p-1 shadow-md"
							>
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors text-left"
									onClick={() => {
										setMenuOpen(false);
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
										className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors text-left"
										onClick={() => {
											setMenuOpen(false);
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
										className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors text-left"
										onClick={() => {
											setMenuOpen(false);
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
}: QueueListProps) {
	if (items.length === 0) return null;

	return (
		<div className="rounded-xl border bg-background shadow-xs">
			<div className="flex flex-col gap-0.5 p-1 max-h-[108px] overflow-y-auto">
				{items.map((item, idx) => (
					<QueueItemRow
						key={item.id}
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
				))}
			</div>
		</div>
	);
}
