import type { HarnessId } from "../../src/agents/index.ts";
import type { QueueMode } from "../../src/lib/session-drafts.ts";
import type { SelectedModel } from "../../src/types/electron.d.ts";
import type { BackendServiceContext } from "./index.ts";
import type { PromptQueueEntry } from "./prompt-queue-service.ts";

export async function listProjectSessionQueues(input: {
  services: BackendServiceContext;
  projectId: string;
  harnessId: HarnessId;
}): Promise<Record<string, PromptQueueEntry[]>> {
  return await input.services.queues.listProjectQueues({
    projectId: input.projectId,
    harnessId: input.harnessId,
  });
}

export async function listSessionQueue(input: {
  services: BackendServiceContext;
  sessionId: string;
}): Promise<PromptQueueEntry[]> {
  return await input.services.queues.listSessionQueue(input.sessionId);
}

export async function enqueueSessionPrompt(input: {
  services: BackendServiceContext;
  sessionId: string;
  text: string;
  model?: SelectedModel;
  agent?: string;
  variant?: string;
  mode: QueueMode;
  insertAt?: "front" | "back";
}): Promise<PromptQueueEntry[]> {
  return await input.services.queues.enqueue(input.sessionId, {
    text: input.text,
    model: input.model,
    agent: input.agent,
    variant: input.variant,
    mode: input.mode,
    insertAt: input.insertAt,
  });
}

export async function reorderSessionPrompt(input: {
  services: BackendServiceContext;
  sessionId: string;
  entryId: string;
  index: number;
}): Promise<PromptQueueEntry[]> {
  return await input.services.queues.reorder(input.sessionId, input.entryId, input.index);
}

export async function updateSessionPrompt(input: {
  services: BackendServiceContext;
  sessionId: string;
  entryId: string;
  text?: string;
  model?: SelectedModel;
  agent?: string | null;
  variant?: string | null;
  mode?: QueueMode;
}): Promise<PromptQueueEntry[]> {
  return await input.services.queues.update(input.sessionId, input.entryId, {
    text: input.text,
    model: input.model,
    agent: input.agent,
    variant: input.variant,
    mode: input.mode,
  });
}

export async function removeSessionPrompt(input: {
  services: BackendServiceContext;
  sessionId: string;
  entryId: string;
}): Promise<PromptQueueEntry[]> {
  return await input.services.queues.remove(input.sessionId, input.entryId);
}
