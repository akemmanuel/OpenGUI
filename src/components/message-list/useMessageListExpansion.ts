import { useCallback, useEffect, useState } from "react";

export function useMessageListExpansion(activeSessionId: string | null) {
  const [expandedUserMessages, setExpandedUserMessages] = useState<Set<string>>(() => new Set());
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setExpandedUserMessages(new Set());
    setExpandedToolCalls(new Set());
  }, [activeSessionId]);

  const toggleUserMessage = useCallback((messageId: string) => {
    setExpandedUserMessages((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const setToolCallExpanded = useCallback((partId: string, expanded: boolean) => {
    setExpandedToolCalls((current) => {
      const next = new Set(current);
      if (expanded) next.add(partId);
      else next.delete(partId);
      return next;
    });
  }, []);

  return {
    expandedUserMessages,
    expandedToolCalls,
    toggleUserMessage,
    setToolCallExpanded,
  };
}
