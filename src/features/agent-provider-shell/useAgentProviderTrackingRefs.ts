import { useCallback, useMemo, useRef } from "react";
import type { SessionTitleTrackingRefs } from "@/features/agent-sessions";

export function useAgentProviderTrackingRefs() {
  const forcedSessionTitlesRef = useRef<Map<string, string>>(new Map());
  const pendingTitlePersistenceRef = useRef<Map<string, string>>(new Map());
  const sessionIdAliasesRef = useRef<Map<string, string>>(new Map());
  const namingRequestIdsRef = useRef<Map<string, number>>(new Map());

  const selectSessionRequestRef = useRef(0);
  const preservePromptBoxSelectionSessionsRef = useRef<Set<string>>(new Set());
  const childHydrationVersionRef = useRef<Record<string, number>>({});
  const sessionReconcileRequestRef = useRef<Record<string, number>>({});

  const cleanupSessionRefs = useCallback((sessionIds?: Iterable<string>) => {
    if (!sessionIds) {
      forcedSessionTitlesRef.current.clear();
      pendingTitlePersistenceRef.current.clear();
      sessionIdAliasesRef.current.clear();
      namingRequestIdsRef.current.clear();
      preservePromptBoxSelectionSessionsRef.current.clear();
      childHydrationVersionRef.current = {};
      sessionReconcileRequestRef.current = {};
      return;
    }
    const ids = new Set(sessionIds);
    for (const id of ids) {
      forcedSessionTitlesRef.current.delete(id);
      pendingTitlePersistenceRef.current.delete(id);
      namingRequestIdsRef.current.delete(id);
      preservePromptBoxSelectionSessionsRef.current.delete(id);
      delete childHydrationVersionRef.current[id];
      delete sessionReconcileRequestRef.current[id];
    }
    for (const [alias, target] of sessionIdAliasesRef.current.entries()) {
      if (ids.has(alias) || ids.has(target)) {
        sessionIdAliasesRef.current.delete(alias);
      }
    }
  }, []);

  const titleTracking = useMemo<SessionTitleTrackingRefs>(
    () => ({
      forcedTitles: forcedSessionTitlesRef,
      pendingTitlePersistence: pendingTitlePersistenceRef,
      sessionIdAliases: sessionIdAliasesRef,
      namingRequestIds: namingRequestIdsRef,
    }),
    [],
  );

  const noteSessionSelection = useCallback(
    (
      id: string | null,
      options?: {
        preservePromptBoxSelection?: boolean;
      },
    ) => {
      if (!id) return;
      if (options?.preservePromptBoxSelection) {
        preservePromptBoxSelectionSessionsRef.current.add(id);
      } else {
        preservePromptBoxSelectionSessionsRef.current.delete(id);
      }
    },
    [],
  );

  const consumePreservePromptBoxSelection = useCallback((sessionId: string) => {
    const preserve = preservePromptBoxSelectionSessionsRef.current.has(sessionId);
    preservePromptBoxSelectionSessionsRef.current.delete(sessionId);
    return preserve;
  }, []);

  return {
    selectSessionRequestRef,
    cleanupSessionRefs,
    titleTracking,
    noteSessionSelection,
    consumePreservePromptBoxSelection,
  };
}
