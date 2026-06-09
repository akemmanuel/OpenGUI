import { Effect } from "effect";
import type { QueueMode } from "../../src/lib/session-drafts.ts";
import type { SelectedModel } from "../../src/types/electron.d.ts";
import { forkEffect, tryPromiseEffect } from "../../lib/effect-runtime.ts";
import type { BackendServiceContext, ProjectRecord, SessionRecord } from "./index.ts";
import {
  abortSessionThroughHarness,
  promptSessionThroughHarness,
} from "./session-lifecycle-actions.ts";

export type SharedSessionPromptDecision = "dispatch" | "queue";

function queueInsertIndex(mode: QueueMode): "front" | "back" {
  return mode === "interrupt" || mode === "after-part" ? "front" : "back";
}

export function decideSharedSessionPrompt(input: {
  sessionStatus: SessionRecord["status"];
}): SharedSessionPromptDecision {
  return input.sessionStatus === "running" ? "queue" : "dispatch";
}

export async function sendQueuedPromptNow(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
  entryId: string;
}) {
  const scope = { projectId: input.session.projectId, harnessId: input.session.harnessId };
  let entries = await input.services.queues.listSessionQueue(input.session.id, scope);
  const index = entries.findIndex((entry) => entry.id === input.entryId);
  if (index === -1) return entries;

  if (index > 0) {
    entries = await input.services.queues.reorder(input.session.id, input.entryId, 0, scope);
  }

  if (input.session.status === "running") {
    await abortSessionThroughHarness({
      services: input.services,
      project: input.project,
      session: input.session,
    });
    return entries;
  }

  await dispatchFirstQueuedPrompt({
    services: input.services,
    project: input.project,
    session: input.session,
    entries,
  });
  return await input.services.queues.listSessionQueue(input.session.id, scope);
}

async function dispatchFirstQueuedPrompt(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
  entries?: Awaited<ReturnType<BackendServiceContext["queues"]["listSessionQueue"]>>;
}) {
  const scope = { projectId: input.session.projectId, harnessId: input.session.harnessId };
  const entries =
    input.entries ?? (await input.services.queues.listSessionQueue(input.session.id, scope));
  const next = entries[0];
  if (!next) return false;

  await promptSessionThroughHarness({
    services: input.services,
    project: input.project,
    session: input.session,
    text: next.text,
    model: next.model,
    agent: next.agent,
    variant: next.variant,
  });
  await input.services.queues.remove(input.session.id, next.id, scope);
  return true;
}

function dispatchFirstQueuedPromptEffect(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
  entries?: Awaited<ReturnType<BackendServiceContext["queues"]["listSessionQueue"]>>;
}) {
  return tryPromiseEffect(() => dispatchFirstQueuedPrompt(input));
}

export async function submitSessionPrompt(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
  text: string;
  model?: SelectedModel;
  agent?: string;
  variant?: string;
  mode?: QueueMode;
}): Promise<{ dispatched: boolean }> {
  const mode = input.mode ?? "queue";
  const decision = decideSharedSessionPrompt({ sessionStatus: input.session.status });

  if (decision === "queue") {
    await input.services.queues.enqueue(
      input.session.id,
      {
        text: input.text,
        model: input.model,
        agent: input.agent,
        variant: input.variant,
        mode,
        insertAt: queueInsertIndex(mode),
      },
      { projectId: input.session.projectId, harnessId: input.session.harnessId },
    );
    if (mode === "interrupt") {
      await abortSessionThroughHarness({
        services: input.services,
        project: input.project,
        session: input.session,
      });
    }
    return { dispatched: false };
  }

  await promptSessionThroughHarness({
    services: input.services,
    project: input.project,
    session: input.session,
    text: input.text,
    model: input.model,
    agent: input.agent,
    variant: input.variant,
  });
  return { dispatched: true };
}

export function registerSharedSessionControl(input: {
  services: BackendServiceContext;
}): () => void {
  const dispatching = new Set<string>();

  return input.services.events.on("session.updated", ({ session }) => {
    if (session.status !== "idle") return;
    if (dispatching.has(session.id)) return;

    dispatching.add(session.id);
    forkEffect(
      Effect.gen(function* () {
        const project = yield* tryPromiseEffect(() =>
          input.services.projects.getProject(session.projectId),
        );
        if (!project) return;

        yield* dispatchFirstQueuedPromptEffect({
          services: input.services,
          project,
          session,
        });
      }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            input.services.events.emit(
              "runtime.error",
              {
                message: "Failed to dispatch queued prompt",
                error: error instanceof Error ? error.message : String(error),
              },
              { projectId: session.projectId, sessionId: session.id, harnessId: session.harnessId },
            );
          }),
        ),
        Effect.ensuring(Effect.sync(() => dispatching.delete(session.id))),
      ),
    );
  });
}
