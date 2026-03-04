/**
 * Shared todo-list types and utilities.
 *
 * Both the inline TodoListView (in MessageList) and the right-side TodoSidebar
 * use these definitions so they stay in sync.
 */

import type { Part, ToolPart } from "@opencode-ai/sdk/v2/client";
import { Circle, CircleCheck, CircleDot, CircleOff } from "lucide-react";
import { useMemo } from "react";
import type { MessageEntry } from "@/hooks/use-opencode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TodoItem {
	content: string;
	status: string;
	priority: string;
}

// ---------------------------------------------------------------------------
// Status display config
// ---------------------------------------------------------------------------

export const todoStatusConfig: Record<
	string,
	{ icon: typeof Circle; color: string; label: string }
> = {
	in_progress: {
		icon: CircleDot,
		color: "text-blue-400",
		label: "In Progress",
	},
	pending: { icon: Circle, color: "text-muted-foreground", label: "Pending" },
	completed: {
		icon: CircleCheck,
		color: "text-emerald-500",
		label: "Completed",
	},
	cancelled: {
		icon: CircleOff,
		color: "text-red-400 opacity-60",
		label: "Cancelled",
	},
};

/** Ordered status keys for display (in-progress first for visibility). */
export const STATUS_ORDER = [
	"in_progress",
	"pending",
	"completed",
	"cancelled",
] as const;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Try to extract a todo array from a todowrite tool part's state. */
export function extractTodos(state: ToolPart["state"]): TodoItem[] | null {
	try {
		if ("input" in state && state.input) {
			const raw = state.input.todos;
			if (Array.isArray(raw) && raw.length > 0) {
				return raw.filter(
					(t): t is TodoItem =>
						typeof t === "object" &&
						t !== null &&
						typeof t.content === "string" &&
						typeof t.status === "string",
				);
			}
		}
	} catch {
		/* ignore */
	}
	return null;
}

// ---------------------------------------------------------------------------
// Hook: extract the latest todo snapshot from a message list
// ---------------------------------------------------------------------------

/**
 * Walks backwards through messages to find the last `todowrite` tool call and
 * returns its todo items.  Each `TodoWrite` invocation contains the full
 * authoritative list, so only the latest one matters.
 */
export function useSessionTodos(messages: MessageEntry[]): TodoItem[] | null {
	return useMemo(() => {
		// Walk messages backwards (most recent first)
		for (let i = messages.length - 1; i >= 0; i--) {
			const parts = messages[i]?.parts;
			if (!parts) continue;
			// Walk parts backwards within the message
			for (let j = parts.length - 1; j >= 0; j--) {
				const part = parts[j] as Part;
				if (part.type !== "tool") continue;
				const toolPart = part as ToolPart;
				if (toolPart.tool.toLowerCase() !== "todowrite") continue;
				const todos = extractTodos(toolPart.state);
				if (todos && todos.length > 0) return todos;
			}
		}
		return null;
	}, [messages]);
}
