import { useMemo } from "react";
import type { useActions } from "@/hooks/use-agent-state";

type Actions = ReturnType<typeof useActions>;

interface UseActiveSessionQueueParams {
  activeSessionId: string | null;
  getQueuedPrompts: Actions["getQueuedPrompts"];
  removeFromQueue: Actions["removeFromQueue"];
  reorderQueue: Actions["reorderQueue"];
  updateQueuedPrompt: Actions["updateQueuedPrompt"];
  sendQueuedNow: Actions["sendQueuedNow"];
}

export function useActiveSessionQueue({
  activeSessionId,
  getQueuedPrompts,
  removeFromQueue,
  reorderQueue,
  updateQueuedPrompt,
  sendQueuedNow,
}: UseActiveSessionQueueParams) {
  const queuedPrompts = activeSessionId ? getQueuedPrompts(activeSessionId) : [];

  const queueHandlers = useMemo(
    () => ({
      remove: (id: string) => {
        if (!activeSessionId) return;
        removeFromQueue(activeSessionId, id);
      },
      moveUp: (index: number) => {
        if (!activeSessionId) return;
        reorderQueue(activeSessionId, index, index - 1);
      },
      moveDown: (index: number) => {
        if (!activeSessionId) return;
        reorderQueue(activeSessionId, index, index + 1);
      },
      moveToTop: (index: number) => {
        if (!activeSessionId) return;
        reorderQueue(activeSessionId, index, 0);
      },
      moveToBottom: (index: number) => {
        if (!activeSessionId) return;
        reorderQueue(activeSessionId, index, queuedPrompts.length - 1);
      },
      edit: (id: string, newText: string) => {
        if (!activeSessionId) return;
        updateQueuedPrompt(activeSessionId, id, newText);
      },
      sendNow: (id: string) => {
        if (!activeSessionId) return;
        void sendQueuedNow(activeSessionId, id);
      },
      reorder: (fromIndex: number, toIndex: number) => {
        if (!activeSessionId) return;
        reorderQueue(activeSessionId, fromIndex, toIndex);
      },
    }),
    [
      activeSessionId,
      queuedPrompts.length,
      removeFromQueue,
      reorderQueue,
      sendQueuedNow,
      updateQueuedPrompt,
    ],
  );

  return { queuedPrompts, queueHandlers };
}
