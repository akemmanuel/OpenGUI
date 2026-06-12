import { useCallback, useRef, useState } from "react";
import type { Session } from "@/hooks/agent-state-types";

export function useSidebarRename({
  sessions,
  renameSession,
}: {
  sessions: Session[];
  renameSession: (sessionId: string, title: string) => void | Promise<void>;
}) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  const startEditing = useCallback((sessionId: string, currentTitle: string) => {
    setEditingSessionId(sessionId);
    setEditValue(currentTitle);
  }, []);

  const commitRename = useCallback(() => {
    if (editingSessionId) {
      const trimmed = editValue.trim();
      if (trimmed && trimmed !== editingSessionId) {
        const session = sessions.find((s) => s.id === editingSessionId);
        if (trimmed !== (session?.title || "")) void renameSession(editingSessionId, trimmed);
      }
    }
    setEditingSessionId(null);
    setEditValue("");
  }, [editingSessionId, editValue, sessions, renameSession]);

  const cancelEditing = useCallback(() => {
    setEditingSessionId(null);
    setEditValue("");
  }, []);

  return {
    editingSessionId,
    editValue,
    setEditValue,
    editInputRef,
    startEditing,
    commitRename,
    cancelEditing,
  };
}
