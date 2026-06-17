import type { HarnessId } from "../../src/agents/index.ts";
import type { QueueMode } from "../../src/lib/session-drafts.ts";
import type { SelectedModel } from "../../src/types/electron.d.ts";
import type { BackendServiceContext } from "./index.ts";
import type { PromptQueueEntry } from "./prompt-queue-service.ts";

export async function listDirectorySessionQueues(input: {
  services: BackendServiceContext;
  directory: string;
  harnessId: HarnessId;
}): Promise<Record<string, PromptQueueEntry[]>> {
  return await input.services.queues.listProjectQueues({
    directory: input.directory,
    harnessId: input.harnessId,
  });
}

export async function listSessionQueue(input: {
  services: BackendServiceContext;
  sessionId: string;
  directory: string;
  harnessId: HarnessId;
}): Promise<PromptQueueEntry[]> {
  return await input.services.queues.listSessionQueue(input.sessionId, {
    directory: input.directory,
    harnessId: input.harnessId,
  });
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
  directory: string;
  harnessId: HarnessId;
}): Promise<PromptQueueEntry[]> {
  return await input.services.queues.enqueue(
    input.sessionId,
    {
      text: input.text,
      model: input.model,
      agent: input.agent,
      variant: input.variant,
      mode: input.mode,
      insertAt: input.insertAt,
    },
    { directory: input.directory, harnessId: input.harnessId },
  );
}

export async function reorderSessionPrompt(input: {
  services: BackendServiceContext;
  sessionId: string;
  entryId: string;
  index: number;
  directory: string;
  harnessId: HarnessId;
}): Promise<PromptQueueEntry[]> {
  return await input.services.queues.reorder(input.sessionId, input.entryId, input.index, {
    directory: input.directory,
    harnessId: input.harnessId,
  });
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
  directory: string;
  harnessId: HarnessId;
}): Promise<PromptQueueEntry[]> {
  return await input.services.queues.update(
    input.sessionId,
    input.entryId,
    {
      text: input.text,
      model: input.model,
      agent: input.agent,
      variant: input.variant,
      mode: input.mode,
    },
    { directory: input.directory, harnessId: input.harnessId },
  );
}

export async function removeSessionPrompt(input: {
  services: BackendServiceContext;
  sessionId: string;
  entryId: string;
  directory: string;
  harnessId: HarnessId;
}): Promise<PromptQueueEntry[]> {
  return await input.services.queues.remove(input.sessionId, input.entryId, {
    directory: input.directory,
    harnessId: input.harnessId,
  });
}
