import type { HarnessId } from "@/agents";
import type { Session } from "@/hooks/agent-state-types";
import {
  resolveActiveResourceHarnessRoute,
  resolveSessionHarnessRoute,
} from "@/hooks/agent-harness-routing";
import type { SelectedModel } from "@/types/electron";

/** Frontend-local execution intent for the next Agent send (see CONTEXT PromptBox selection). */
export type PromptBoxSelection = {
  harnessId: HarnessId;
  model: SelectedModel;
};

export type PromptBoxSelectionHarnessInput = {
  activeSession: Session | null | undefined;
  activeTargetHarnessId: HarnessId | null;
  /** Last explicit harness from storage / bootstrap until user picks in selector (T2). */
  fallbackHarnessId: HarnessId;
};

/** Resolved harness for resources, routing, and send (session lock wins). */
export function resolvePromptBoxHarnessId(input: PromptBoxSelectionHarnessInput): HarnessId {
  return resolveActiveResourceHarnessRoute({
    activeSession: input.activeSession,
    activeTargetHarnessId: input.activeTargetHarnessId,
    preferredHarnessId: input.fallbackHarnessId,
  }).harnessId;
}

export function isPromptBoxSelectionComplete(input: {
  harnessId: HarnessId | null;
  selectedModel: SelectedModel | null;
}): boolean {
  return Boolean(input.harnessId && input.selectedModel);
}

/** True when an Agent send may be dispatched (harness + model). */
export function hasPromptBoxSelectionForSend(input: {
  activeSession: Session | null | undefined;
  activeTargetHarnessId: HarnessId | null;
  fallbackHarnessId: HarnessId;
  selectedModel: SelectedModel | null;
}): boolean {
  const harnessId = resolvePromptBoxHarnessId({
    activeSession: input.activeSession,
    activeTargetHarnessId: input.activeTargetHarnessId,
    fallbackHarnessId: input.fallbackHarnessId,
  });
  return isPromptBoxSelectionComplete({ harnessId, selectedModel: input.selectedModel });
}

export function openPromptBoxSelectionDialog() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("open-model-selector"));
}

export function resolveHarnessIdForSend(input: {
  session: Session | null | undefined;
  activeTargetHarnessId: HarnessId | null;
  fallbackHarnessId: HarnessId;
}): HarnessId | null {
  if (input.session) {
    return resolveSessionHarnessRoute(input.session).harnessId;
  }
  return (
    input.activeTargetHarnessId ??
    resolveActiveResourceHarnessRoute({
      activeSession: null,
      activeTargetHarnessId: input.activeTargetHarnessId,
      preferredHarnessId: input.fallbackHarnessId,
    }).harnessId
  );
}
