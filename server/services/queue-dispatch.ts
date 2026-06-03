import type { BackendServiceContext, ProjectRecord, SessionRecord } from "./index.ts";
import { promptSessionThroughHarness } from "./session-lifecycle-actions.ts";

export async function dispatchNextQueuedPromptThroughHarness(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
}) {
  const entries = await input.services.queues.listSessionQueue(input.session.id);
  const next = entries[0];
  if (!next) return entries;

  await input.services.queues.remove(input.session.id, next.id);
  await promptSessionThroughHarness({
    services: input.services,
    project: input.project,
    session: input.session,
    text: next.text,
    images: next.images,
    model: next.model,
    agent: next.agent,
    variant: next.variant,
  });
  return await input.services.queues.listSessionQueue(input.session.id);
}
