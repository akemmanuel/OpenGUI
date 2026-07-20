import type { MessageEntry } from "@/hooks/agent-state-types";
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

/** Build footer metadata and timing directly from the canonical transcript turn. */
function footerFromTranscriptTurn(
  assistantTurn: AssistantTurn,
  running: boolean,
): TurnFooter | null {
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
  const completedAt = entry.info.time.completed;
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
  const startedAt = parent?.info.role === "user" ? parent.info.time.created : undefined;
  const hasDuration =
    typeof startedAt === "number" &&
    (running || (typeof completedAt === "number" && completedAt > startedAt));

  if (!providerID && !modelID && !thinkingLevel && !hasDuration) return null;

  return {
    startedAt,
    completedAt,
    running,
    providerID,
    modelID,
    thinkingLevel,
  };
}

export function buildTurnFooterByMessageId(
  visibleMessages: MessageEntry[],
  isBusy: boolean,
): Map<string, TurnFooter> {
  const footerByMessageId = new Map<string, TurnFooter>();
  const assistantTurns = groupAssistantTurns(visibleMessages);
  const latestUserId = visibleMessages.findLast((entry) => entry.info.role === "user")?.info.id;

  for (const assistantTurn of assistantTurns) {
    const entry = assistantTurn.assistants.at(-1);
    if (!entry) continue;
    const running = isBusy && assistantTurn.user?.info.id === latestUserId;
    const footer = footerFromTranscriptTurn(assistantTurn, running);
    if (footer) footerByMessageId.set(entry.info.id, footer);
  }

  return footerByMessageId;
}
