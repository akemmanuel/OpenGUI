import type { MessageEntry, TurnRun } from "@/hooks/agent-state-types";
import type { TurnFooter } from "@/components/message-list/types";

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

type AssistantTurn = {
  user?: MessageEntry;
  assistants: MessageEntry[];
};

function groupAssistantTurns(visibleMessages: MessageEntry[]): AssistantTurn[] {
  const assistantTurns: AssistantTurn[] = [];
  let currentTurn: AssistantTurn | null = null;

  const flushTurn = () => {
    if (currentTurn?.assistants.length) assistantTurns.push(currentTurn);
  };

  for (const entry of visibleMessages) {
    if (entry.info.role === "user") {
      flushTurn();
      currentTurn = { user: entry, assistants: [] };
      continue;
    }
    if (entry.info.role !== "assistant") continue;
    if (!currentTurn) currentTurn = { assistants: [] };
    currentTurn.assistants.push(entry);
  }
  flushTurn();

  return assistantTurns;
}

/** Footer fields inferred from transcript messages when no turn run is bound. */
function footerFromTranscriptTurn(assistantTurn: AssistantTurn): TurnFooter | null {
  const entry = assistantTurn.assistants.at(-1);
  if (!entry) return null;

  const assistantWithProvider = assistantTurn.assistants.findLast(
    (item) => "providerID" in item.info && typeof item.info.providerID === "string",
  );
  const assistantWithModel = assistantTurn.assistants.findLast(
    (item) => "modelID" in item.info && typeof item.info.modelID === "string",
  );
  const assistantWithVariant = assistantTurn.assistants.findLast(
    (item) => "variant" in item.info && nonEmptyString(item.info.variant),
  );
  const providerID =
    assistantWithProvider && "providerID" in assistantWithProvider.info
      ? assistantWithProvider.info.providerID
      : undefined;
  const modelID =
    assistantWithModel && "modelID" in assistantWithModel.info
      ? assistantWithModel.info.modelID
      : undefined;
  const completedAssistant = assistantTurn.assistants.findLast(
    (item) => typeof (item.info.time as { completed?: number }).completed === "number",
  );
  const completedAt = completedAssistant
    ? (completedAssistant.info.time as { completed?: number }).completed
    : undefined;
  const parent = assistantTurn.user;
  const parentModel =
    parent?.info.role === "user" && "model" in parent.info ? parent.info.model : null;
  const thinkingLevel =
    (assistantWithVariant && "variant" in assistantWithVariant.info
      ? nonEmptyString(assistantWithVariant.info.variant)
      : undefined) ??
    (parentModel && typeof parentModel === "object" && "variant" in parentModel
      ? nonEmptyString(parentModel.variant)
      : undefined);
  const durationMs =
    typeof completedAt === "number" && parent?.info.role === "user"
      ? completedAt - parent.info.time.created
      : undefined;

  if (!providerID && !modelID && !thinkingLevel && !(durationMs && durationMs > 0)) return null;

  return {
    durationMs: durationMs && durationMs > 0 ? durationMs : undefined,
    running: false,
    providerID,
    modelID,
    thinkingLevel,
  };
}

function findTurnRunForAssistant(
  assistantTurns: AssistantTurn[],
  turn: TurnRun,
): AssistantTurn | undefined {
  const byBoundMessage = assistantTurns.find((candidate) =>
    candidate.assistants.some((entry) => entry.info.id === turn.assistantMessageID),
  );
  if (byBoundMessage) return byBoundMessage;

  return assistantTurns.find((candidate) => {
    const firstAssistant = candidate.assistants[0];
    const lastAssistant = candidate.assistants.at(-1);
    if (!firstAssistant || !lastAssistant) return false;
    const firstCreated = firstAssistant.info.time.created;
    const lastCreated = lastAssistant.info.time.created;
    return lastCreated >= turn.startedAt && firstCreated <= (turn.completedAt ?? Date.now());
  });
}

function mergeRunWithTranscriptFooter(
  turn: TurnRun,
  transcriptFooter: TurnFooter | null,
): TurnFooter {
  const durationMs =
    typeof turn.completedAt === "number"
      ? turn.completedAt - turn.startedAt
      : transcriptFooter?.durationMs;

  return {
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: durationMs && durationMs > 0 ? durationMs : transcriptFooter?.durationMs,
    running: turn.status === "running",
    providerID: turn.providerID ?? transcriptFooter?.providerID,
    modelID: turn.modelID ?? transcriptFooter?.modelID,
    thinkingLevel: turn.thinkingLevel ?? transcriptFooter?.thinkingLevel,
  };
}

export function buildTurnFooterByMessageId(
  visibleMessages: MessageEntry[],
  turnRuns: Record<string, TurnRun>,
): Map<string, TurnFooter> {
  const footerByMessageId = new Map<string, TurnFooter>();
  const assistantTurns = groupAssistantTurns(visibleMessages);
  const transcriptFooterByAssistantId = new Map<string, TurnFooter>();

  for (const assistantTurn of assistantTurns) {
    const entry = assistantTurn.assistants.at(-1);
    if (!entry) continue;
    const footer = footerFromTranscriptTurn(assistantTurn);
    if (footer) transcriptFooterByAssistantId.set(entry.info.id, footer);
  }

  const runsByStartedAt = Object.values(turnRuns).sort((a, b) => a.startedAt - b.startedAt);

  for (const turn of runsByStartedAt) {
    const assistantTurn = findTurnRunForAssistant(assistantTurns, turn);
    const matchingAssistantId = assistantTurn?.assistants.at(-1)?.info.id;
    if (!matchingAssistantId) continue;

    const transcriptFooter = transcriptFooterByAssistantId.get(matchingAssistantId) ?? null;
    footerByMessageId.set(
      matchingAssistantId,
      mergeRunWithTranscriptFooter(turn, transcriptFooter),
    );
  }

  for (const [assistantId, footer] of transcriptFooterByAssistantId) {
    if (!footerByMessageId.has(assistantId)) {
      footerByMessageId.set(assistantId, footer);
    }
  }

  return footerByMessageId;
}
