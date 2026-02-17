/**
 * Popover that appears above the prompt input when the user types "/".
 * Shows available slash commands filtered by the current input.
 */

import type { Command } from "@opencode-ai/sdk/v2/client";
import { cn } from "@/lib/utils";

interface SlashCommandPopoverProps {
	commands: Command[];
	filter: string;
	activeIndex: number;
	onSelect: (command: Command) => void;
	onHover: (index: number) => void;
}

function matchesFilter(command: Command, filter: string): boolean {
	if (!filter) return true;
	const lower = filter.toLowerCase();
	if (command.name.toLowerCase().includes(lower)) return true;
	if (command.description?.toLowerCase().includes(lower)) return true;
	return false;
}

export function useFilteredCommands(commands: Command[], filter: string) {
	return commands.filter((cmd) => matchesFilter(cmd, filter));
}

export function SlashCommandPopover({
	commands,
	filter,
	activeIndex,
	onSelect,
	onHover,
}: SlashCommandPopoverProps) {
	const filtered = useFilteredCommands(commands, filter);

	if (filtered.length === 0) return null;

	return (
		<div className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-[240px] overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg">
			{filtered.map((cmd, i) => (
				<button
					key={cmd.name}
					type="button"
					className={cn(
						"flex w-full items-center justify-between gap-4 rounded-md px-2.5 py-1.5 text-left text-xs",
						i === activeIndex
							? "bg-accent text-accent-foreground"
							: "hover:bg-accent/50",
					)}
					onMouseDown={(e) => {
						e.preventDefault();
						onSelect(cmd);
					}}
					onMouseEnter={() => onHover(i)}
				>
					<div className="flex min-w-0 items-center gap-2">
						<span className="font-medium text-foreground whitespace-nowrap">
							/{cmd.name}
						</span>
						{cmd.description && (
							<span className="truncate text-muted-foreground">
								{cmd.description}
							</span>
						)}
					</div>
					{cmd.source && cmd.source !== "command" && (
						<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
							{cmd.source}
						</span>
					)}
				</button>
			))}
		</div>
	);
}
