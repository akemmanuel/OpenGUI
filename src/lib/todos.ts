/**
 * Shared todo-list types and utilities.
 *
 * Shared todo-list types, status config, and extraction helpers used by the
 * inline TodoListView in MessageList.
 */

import type { ToolPart } from "@opencode-ai/sdk/v2/client";
import { Circle, CircleCheck, CircleDot, CircleOff } from "lucide-react";

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
