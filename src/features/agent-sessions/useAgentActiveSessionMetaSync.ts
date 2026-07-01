import { useEffect } from "react";
import type { Action } from "@/hooks/agent-reducer";
import { selectedModelsEqual, selectedVariantsEqual } from "@/hooks/agent-model-selection";
import type { InternalAgentState } from "@/hooks/agent-state-types";

export function useAgentActiveSessionMetaSync(input: {
  state: InternalAgentState;
  currentVariant: string | undefined;
  dispatch: (action: Action) => void;
}) {
  const { state, currentVariant, dispatch } = input;

  useEffect(() => {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    const existing = state.sessionMeta[sessionId] ?? {};
    const nextSelectedVariant = currentVariant ?? null;
    if (
      selectedModelsEqual(existing.selectedModel, state.selectedModel) &&
      existing.selectedAgent === state.selectedAgent &&
      selectedVariantsEqual(existing.selectedVariant, nextSelectedVariant)
    ) {
      return;
    }
    dispatch({
      type: "SET_SESSION_META",
      payload: {
        sessionId,
        meta: {
          selectedModel: state.selectedModel,
          selectedAgent: state.selectedAgent,
          selectedVariant: nextSelectedVariant,
        },
      },
    });
  }, [
    currentVariant,
    dispatch,
    state.activeSessionId,
    state.selectedAgent,
    state.selectedModel,
    state.sessionMeta,
  ]);
}
