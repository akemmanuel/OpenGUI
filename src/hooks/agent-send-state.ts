import type { TurnRun } from "@/hooks/agent-state-types";
import type { AgentSendSelection } from "@/hooks/agent-send";
import { createUuid } from "@/lib/utils";

export interface PromptSendState {
  turnRun: TurnRun;
  promptSubmitted: {
    id: string;
    sessionID: string;
    text: string;
    createdAt: number;
  };
}

export function createTurnRunStart({
  sessionId,
  selection,
  startedAt = Date.now(),
  turnId = createUuid(),
}: {
  sessionId: string;
  selection: AgentSendSelection;
  startedAt?: number;
  turnId?: string;
}): TurnRun {
  return {
    id: turnId,
    sessionID: sessionId,
    startedAt,
    status: "running",
    providerID: selection.model?.providerID,
    modelID: selection.model?.modelID,
    thinkingLevel: selection.variant,
  };
}

export function createPromptSendState({
  sessionId,
  text,
  selection,
  startedAt = Date.now(),
  turnId = createUuid(),
}: {
  sessionId: string;
  text: string;
  selection: AgentSendSelection;
  startedAt?: number;
  turnId?: string;
}): PromptSendState {
  return {
    turnRun: createTurnRunStart({ sessionId, selection, startedAt, turnId }),
    promptSubmitted: {
      id: turnId,
      sessionID: sessionId,
      text,
      createdAt: startedAt,
    },
  };
}

export function nextNamingRequestId(current: number | undefined): number {
  return (current ?? 0) + 1;
}
