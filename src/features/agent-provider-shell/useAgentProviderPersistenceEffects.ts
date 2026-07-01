import { useEffect } from "react";
import { persistUnreadSessionIds } from "@/hooks/agent-state-persistence";
import { persistSessionDrafts } from "@/lib/session-drafts";
import type { InternalAgentState } from "@/hooks/agent-state-types";

export function useAgentProviderPersistenceEffects(state: InternalAgentState) {
  useEffect(() => {
    persistUnreadSessionIds(state.unreadSessionIds);
  }, [state.unreadSessionIds]);

  useEffect(() => {
    persistSessionDrafts(state.sessionDrafts);
  }, [state.sessionDrafts]);

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);
}
