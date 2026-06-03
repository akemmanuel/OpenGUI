import type { Agent } from "@opencode-ai/sdk/v2/client";
import type { VariantSelections } from "@/hooks/use-agent-variant-core";
import { resolveVariant } from "@/hooks/use-agent-variant-core";
import type { QueueMode, QueuedPrompt } from "@/lib/session-drafts";
import type { SelectedModel } from "@/types/electron";
import { createUuid } from "@/lib/utils";

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
  id = createUuid(),
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

export interface PromptQueueEffect {
  enqueue: {
    text: string;
    images?: string[];
    model?: QueuedPrompt["model"];
    agent?: string;
    variant?: string;
    mode: QueueMode;
    insertAt: "front" | "back";
  };
  afterEnqueue: "abort" | "mark-after-part-pending" | "none";
}

export function createPromptQueueEffect(
  decision: Extract<PromptDispatchDecision, { type: "queue" }>,
): PromptQueueEffect {
  return {
    enqueue: {
      text: decision.prompt.text,
      images: decision.prompt.images,
      model: decision.prompt.model,
      agent: decision.prompt.agent,
      variant: decision.prompt.variant,
      mode: decision.prompt.mode,
      insertAt: decision.insertAt,
    },
    afterEnqueue: decision.shouldAbort
      ? "abort"
      : decision.shouldSetAfterPartPending
        ? "mark-after-part-pending"
        : "none",
  };
}

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
