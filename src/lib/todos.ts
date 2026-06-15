/**
 * Shared todo-list types and utilities.
 *
 * Shared todo-list types, status config, and extraction helpers used by the
 * inline TodoListView in MessageList.
 */

import { Circle, CircleCheck, CircleDot, CircleOff } from "lucide-react";
import type { ToolCallState } from "@/protocol/session-transcript";

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

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Try to extract a todo array from a todowrite tool part's state. */
export function extractTodos(state: ToolCallState): TodoItem[] | null {
  try {
    if ("input" in state && state.input && typeof state.input === "object") {
      const raw = (state.input as Record<string, unknown>).todos;
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
