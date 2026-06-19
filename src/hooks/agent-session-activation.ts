import { type MutableRefObject, useCallback } from "react";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";

type SessionActivationDispatch = (
  action:
    | { type: "SET_ACTIVE_SESSION"; payload: string | null }
    | { type: "SESSION_ERROR"; payload: { sessionID?: string; error: string } },
) => void;

export function deriveSelectionFromMessages(
  messages: import("@/hooks/agent-state-types").MessageEntry[],
) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const info = messages[i]?.info;
    if (!info || typeof info !== "object") continue;
    if (info.role !== "user") continue;
    const selectedAgent =
      "agent" in info && typeof info.agent === "string" ? info.agent : undefined;
    const variant =
      "variant" in info && typeof info.variant === "string" ? info.variant : undefined;
    if (
      "providerID" in info &&
      typeof info.providerID === "string" &&
      "modelID" in info &&
      typeof info.modelID === "string"
    ) {
      return {
        selectedModel: {
          providerID: info.providerID,
          modelID: info.modelID,
        },
        selectedAgent,
        variant,
      };
    }
    if (
      "model" in info &&
      info.model &&
      typeof info.model === "object" &&
      "providerID" in info.model &&
      typeof info.model.providerID === "string" &&
      "modelID" in info.model &&
      typeof info.model.modelID === "string"
    ) {
      return {
        selectedModel: {
          providerID: info.model.providerID,
          modelID: info.model.modelID,
        },
        selectedAgent,
        variant,
      };
    }
  }
  return { selectedModel: null, selectedAgent: null, variant: undefined };
}

export function useAgentSessionActivation({
  dispatch,
  stateRef,
  noteSessionSelection,
}: {
  dispatch: SessionActivationDispatch;
  stateRef: MutableRefObject<InternalAgentState>;
  noteSessionSelection?: (
    id: string | null,
    options?: {
      session?: Session | null;
      force?: boolean;
      preserveSelectionOnFailure?: boolean;
      preservePromptBoxSelection?: boolean;
    },
  ) => void;
}) {
  const selectSession = useCallback(
    async (
      id: string | null,
      options?: {
        session?: Session | null;
        force?: boolean;
        preserveSelectionOnFailure?: boolean;
        preservePromptBoxSelection?: boolean;
      },
    ) => {
      if (!options?.force && id === stateRef.current.activeSessionId) return;
      noteSessionSelection?.(id, options);
      dispatch({ type: "SET_ACTIVE_SESSION", payload: id });
    },
    [dispatch, noteSessionSelection, stateRef],
  );

  return { selectSession };
}
