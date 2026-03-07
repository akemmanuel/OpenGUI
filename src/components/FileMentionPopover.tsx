/**
 * Popover that appears above the prompt input when the user types "@".
 * Shows matching file paths from the project, filtered by the query after "@".
 */

import { FileText, Folder } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

interface FileMentionPopoverProps {
	files: string[];
	activeIndex: number;
	onSelect: (filePath: string) => void;
	onHover: (index: number) => void;
	loading?: boolean;
}

export function FileMentionPopover({
	files,
	activeIndex,
	onSelect,
	onHover,
	loading,
}: FileMentionPopoverProps) {
	const listRef = React.useRef<HTMLDivElement>(null);

	// Scroll the active item into view
	React.useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const active = list.children[activeIndex] as HTMLElement | undefined;
		active?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	if (files.length === 0 && !loading) return null;

	return (
		<div
			ref={listRef}
			className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-[240px] overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
		>
			{loading && files.length === 0 && (
				<div className="px-2.5 py-2 text-xs text-muted-foreground">
					Searching...
				</div>
			)}
			{files.map((filePath, i) => {
				const parts = filePath.split("/");
				const fileName = parts[parts.length - 1] ?? filePath;
				const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
				const isDir = filePath.endsWith("/");

				return (
					<button
						key={filePath}
						type="button"
						className={cn(
							"flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs",
							i === activeIndex
								? "bg-accent text-accent-foreground"
								: "hover:bg-accent/50",
						)}
						onMouseDown={(e) => {
							e.preventDefault();
							onSelect(filePath);
						}}
						onMouseEnter={() => onHover(i)}
					>
						{isDir ? (
							<Folder className="size-3.5 shrink-0 text-muted-foreground" />
						) : (
							<FileText className="size-3.5 shrink-0 text-muted-foreground" />
						)}
						<span className="min-w-0 truncate">
							<span className="font-medium text-foreground">{fileName}</span>
							{dir && (
								<span className="ml-1.5 text-muted-foreground">{dir}</span>
							)}
						</span>
					</button>
				);
			})}
		</div>
	);
}
