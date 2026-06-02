import * as React from "react";
import type { MessageEntry } from "@/hooks/agent-state-types";

export function isCompactionTurnInProgress({
  isLoading,
  messages,
}: {
  isLoading?: boolean;
  messages: MessageEntry[];
}) {
  if (!isLoading || messages.length < 2) return false;
  const lastMsg = messages.at(-1);
  const prevMsg = messages.at(-2);
  if (!lastMsg || !prevMsg) return false;
  return (
    lastMsg.info.role === "user" &&
    prevMsg.info.role === "assistant" &&
    "summary" in prevMsg.info &&
    prevMsg.info.summary === true
  );
}

export function usePromptCompaction({
  isLoading,
  messages,
  summarizeSession,
}: {
  isLoading?: boolean;
  messages: MessageEntry[];
  summarizeSession: () => Promise<void>;
}) {
  const [isCompacting, setIsCompacting] = React.useState(false);
  const isCompactingInProgress = React.useMemo(
    () => isCompactionTurnInProgress({ isLoading, messages }),
    [isLoading, messages],
  );

  const compact = React.useCallback(async () => {
    setIsCompacting(true);
    try {
      await summarizeSession();
    } finally {
      setIsCompacting(false);
    }
  }, [summarizeSession]);

  return {
    isCompacting,
    isCompactingInProgress,
    isCompactingOrInProgress: isCompacting || isCompactingInProgress,
    compact,
  };
}
