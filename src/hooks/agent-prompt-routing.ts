import type { Agent } from "@opencode-ai/sdk/v2/client";
import type { VariantSelections } from "@/hooks/use-agent-variant-core";
import { resolveVariant } from "@/hooks/use-agent-variant-core";
import type { QueueMode, QueuedPrompt } from "@/lib/session-drafts";
import type { SelectedModel } from "@/types/electron";

interface PromptSelectionSnapshot {
  selectedModel: SelectedModel | null;
  selectedAgent: string | null;
  variantSelections: VariantSelections;
  agents: Agent[];
}

interface CreateQueuedPromptSnapshotInput extends PromptSelectionSnapshot {
  text: string;
  images?: string[];
  mode: QueueMode;
  now?: number;
  id?: string;
}

export function createQueuedPromptSnapshot({
  text,
  images,
  mode,
  selectedModel,
  selectedAgent,
  variantSelections,
  agents,
  now = Date.now(),
  id = crypto.randomUUID(),
}: CreateQueuedPromptSnapshotInput): QueuedPrompt {
  return {
    id,
    text,
    images,
    createdAt: now,
    model: selectedModel ?? undefined,
    agent: selectedAgent ?? undefined,
    variant: resolveVariant(selectedModel, variantSelections, agents, selectedAgent),
    mode,
  };
}

interface DecidePromptDispatchInput extends CreateQueuedPromptSnapshotInput {
  isBusy: boolean;
}

export type PromptDispatchDecision =
  | { type: "send-direct" }
  | {
      type: "queue";
      prompt: QueuedPrompt;
      insertAt: "front" | "back";
      shouldAbort: boolean;
      shouldSetAfterPartPending: boolean;
    };

export function decidePromptDispatch({
  isBusy,
  text,
  images,
  mode,
  selectedModel,
  selectedAgent,
  variantSelections,
  agents,
  now,
  id,
}: DecidePromptDispatchInput): PromptDispatchDecision {
  if (!isBusy) {
    return { type: "send-direct" };
  }

  const prompt = createQueuedPromptSnapshot({
    text,
    images,
    mode,
    selectedModel,
    selectedAgent,
    variantSelections,
    agents,
    now,
    id,
  });

  if (mode === "interrupt") {
    return {
      type: "queue",
      prompt,
      insertAt: "front",
      shouldAbort: true,
      shouldSetAfterPartPending: false,
    };
  }

  if (mode === "after-part") {
    return {
      type: "queue",
      prompt,
      insertAt: "front",
      shouldAbort: false,
      shouldSetAfterPartPending: true,
    };
  }

  return {
    type: "queue",
    prompt,
    insertAt: "back",
    shouldAbort: false,
    shouldSetAfterPartPending: false,
  };
}
