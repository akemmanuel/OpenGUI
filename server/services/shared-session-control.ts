import type { QueueMode, SelectedModel } from "@opengui/protocol";
import { Effect } from "effect";
import { forkEffect, tryPromiseEffect } from "../../lib/effect-runtime.ts";
import type { DirectoryScopeRef } from "@opengui/runtime";
import type { BackendServiceContext, SessionRecord } from "./index.ts";
import {
  abortSessionThroughHarness,
  promptSessionThroughHarness,
} from "./session-lifecycle-actions.ts";
import { queueScopeForSession, resolveSessionDirectoryScope } from "./directory-scope.ts";

export type SharedSessionPromptDecision = "dispatch" | "queue";

function queueInsertIndex(mode: QueueMode): "front" | "back" {
  return mode === "interrupt" || mode === "after-part" ? "front" : "back";
}

function queueScopeFromDirectory(session: SessionRecord, scopeRef: DirectoryScopeRef) {
  const canonical = scopeRef.canonicalPath || scopeRef.path;
  return queueScopeForSession(session, canonical);
}

export function decideSharedSessionPrompt(input: {
  sessionStatus: SessionRecord["status"];
}): SharedSessionPromptDecision {
  return input.sessionStatus === "running" ? "queue" : "dispatch";
}

export async function sendQueuedPromptNow(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
  entryId: string;
}) {
  const scope = queueScopeFromDirectory(input.session, input.scopeRef);
  let entries = await input.services.queues.listSessionQueue(input.session.id, scope);
  const index = entries.findIndex((entry) => entry.id === input.entryId);
  if (index === -1) return entries;

  if (index > 0) {
    entries = await input.services.queues.reorder(input.session.id, input.entryId, 0, scope);
  }

  if (input.session.status === "running") {
    await abortSessionThroughHarness({
      services: input.services,
      scopeRef: input.scopeRef,
      session: input.session,
    });
    return entries;
  }

  await dispatchFirstQueuedPrompt({
    services: input.services,
    scopeRef: input.scopeRef,
    session: input.session,
    entries,
  });
  return await input.services.queues.listSessionQueue(input.session.id, scope);
}

async function dispatchFirstQueuedPrompt(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
  entries?: Awaited<ReturnType<BackendServiceContext["queues"]["listSessionQueue"]>>;
}) {
  const scope = queueScopeFromDirectory(input.session, input.scopeRef);
  const entries =
    input.entries ?? (await input.services.queues.listSessionQueue(input.session.id, scope));
  const next = entries[0];
  if (!next) return false;

  await promptSessionThroughHarness({
    services: input.services,
    scopeRef: input.scopeRef,
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
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
  entries?: Awaited<ReturnType<BackendServiceContext["queues"]["listSessionQueue"]>>;
}) {
  return tryPromiseEffect(() => dispatchFirstQueuedPrompt(input));
}

export async function submitSessionPrompt(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
  text: string;
  model?: SelectedModel;
  agent?: string;
  variant?: string;
  mode?: QueueMode;
}): Promise<{ dispatched: boolean }> {
  const mode = input.mode ?? "queue";
  const decision = decideSharedSessionPrompt({ sessionStatus: input.session.status });
  const scope = queueScopeFromDirectory(input.session, input.scopeRef);

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
      scope,
    );
    if (mode === "interrupt") {
      await abortSessionThroughHarness({
        services: input.services,
        scopeRef: input.scopeRef,
        session: input.session,
      });
    }
    return { dispatched: false };
  }

  await promptSessionThroughHarness({
    services: input.services,
    scopeRef: input.scopeRef,
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
  resolveSafeDirectory: (path: string) => Promise<string>;
}): () => void {
  const dispatching = new Set<string>();

  return input.services.events.on("session.updated", ({ session }) => {
    if (session.status !== "idle") return;
    if (dispatching.has(session.id)) return;

    dispatching.add(session.id);
    forkEffect(
      Effect.gen(function* () {
        const scopeRef = yield* tryPromiseEffect(() =>
          resolveSessionDirectoryScope({
            session,
            resolveSafeDirectory: input.resolveSafeDirectory,
          }),
        );

        yield* dispatchFirstQueuedPromptEffect({
          services: input.services,
          scopeRef,
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
              {
                directory: session.directory,
                sessionId: session.id,
                harnessId: session.harnessId,
              },
            );
          }),
        ),
        Effect.ensuring(Effect.sync(() => dispatching.delete(session.id))),
      ),
    );
  });
}
