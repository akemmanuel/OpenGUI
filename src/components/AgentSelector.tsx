/**
 * Agent selector dropdown.
 * Shows only primary agents (mode "primary" or "all").
 * Displays agent color dot and name.
 * The default agent ("build") is marked with a server icon.
 */

import { Bot } from "lucide-react";
import { useMemo } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useOpenCode } from "@/hooks/use-opencode";

const DEFAULT_AGENT_NAME = "build";

export function AgentSelector() {
	const { state, setAgent } = useOpenCode();
	const { agents, selectedAgent } = state;

	// Only show primary agents (mode "primary" or "all")
	const primaryAgents = useMemo(
		() =>
			agents
				.filter((a) => (a.mode === "primary" || a.mode === "all") && !a.hidden)
				.sort((a, b) => {
					// Default agent ("build") goes first, rest keeps original order
					const aIsDefault = a.name === DEFAULT_AGENT_NAME ? 1 : 0;
					const bIsDefault = b.name === DEFAULT_AGENT_NAME ? 1 : 0;
					return bIsDefault - aIsDefault;
				}),
		[agents],
	);

	// Resolve null (meaning "use default") to the actual default agent name
	const currentValue = selectedAgent ?? DEFAULT_AGENT_NAME;

	const handleChange = (value: string) => {
		setAgent(value === DEFAULT_AGENT_NAME ? null : value);
	};

	if (primaryAgents.length === 0) return null;

	return (
		<Select value={currentValue} onValueChange={handleChange}>
			<SelectTrigger className="!h-7 w-auto max-w-[180px] gap-1.5 border-none bg-transparent px-2 py-0 text-xs text-muted-foreground shadow-none hover:text-foreground focus:ring-0 [&>svg]:size-3">
				<Bot className="size-3.5 shrink-0" />
				<SelectValue placeholder="Agent" />
			</SelectTrigger>
			<SelectContent align="start" className="max-h-80">
				{primaryAgents.map((agent) => (
					<SelectItem key={agent.name} value={agent.name} className="text-xs">
						<span className="flex items-center gap-1.5">
							{agent.color && (
								<span
									className="inline-block size-2 rounded-full shrink-0"
									style={{ backgroundColor: agent.color }}
								/>
							)}
							<span className="capitalize">{agent.name}</span>
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
