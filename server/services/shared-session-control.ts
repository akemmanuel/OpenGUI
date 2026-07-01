import type { QueueMode, SelectedModel } from "@opengui/protocol";
import type { DirectoryScopeRef } from "@opengui/runtime";
import type { BackendServiceContext, SessionRecord } from "./index.ts";
import {
  abortSessionThroughHarness,
  promptSessionThroughHarness,
} from "./session-lifecycle-actions.ts";
import { queueScopeForSession, resolveSessionDirectoryScope } from "./directory-scope.ts";
import { resolveSessionRecordForMutation } from "./session-resolve.ts";

export type SharedSessionPromptDecision = "dispatch" | "queue";

function queueInsertIndex(mode: QueueMode): "front" | "back" {
  return mode === "interrupt" || mode === "after-part" ? "front" : "back";
}

function queueScopeFromDirectory(session: SessionRecord, scopeRef: DirectoryScopeRef) {
  const canonical = scopeRef.canonicalPath || scopeRef.path;
  return queueScopeForSession(session, canonical);
}

function queueDispatchKey(input: {
  directory: string;
  harnessId: string;
  sessionId: string;
}): string {
  return `${input.directory}\u0000${input.harnessId}\u0000${input.sessionId}`;
}

function isBusyDispatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(busy|running|in progress|active session|already.*run|already.*prompt)\b/i.test(
    message,
  );
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
    try {
      await dispatchFirstQueuedPrompt({
        services: input.services,
        scopeRef: input.scopeRef,
        session: input.session,
      });
    } catch (error) {
      if (!isBusyDispatchError(error)) throw error;
    }
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
  const dispatcher = new QueueDispatcher(input);
  const offSessionUpdated = input.services.events.on("session.updated", ({ session }) => {
    dispatcher.observeSession(session);
  });
  const offLiveEvents = input.services.events.subscribe((event) => {
    dispatcher.observeBackendEvent(event);
  });

  return () => {
    offSessionUpdated();
    offLiveEvents();
  };
}

class QueueDispatcher {
  private readonly dispatching = new Set<string>();
  private readonly input: {
    services: BackendServiceContext;
    resolveSafeDirectory: (path: string) => Promise<string>;
  };

  constructor(input: {
    services: BackendServiceContext;
    resolveSafeDirectory: (path: string) => Promise<string>;
  }) {
    this.input = input;
  }

  observeSession(session: SessionRecord): void {
    if (session.status !== "idle") return;
    this.requestDispatch({
      directory: session.directory,
      harnessId: session.harnessId,
      sessionId: session.id,
      session,
    });
  }

  observeBackendEvent(event: { type: string; payload: unknown }): void {
    if (event.type !== "run.finished") return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || !("scope" in payload)) return;
    const scope = (payload as { scope?: Record<string, unknown> }).scope;
    const directory = typeof scope?.directory === "string" ? scope.directory : undefined;
    const harnessId = typeof scope?.harnessId === "string" ? scope.harnessId : undefined;
    const sessionId = typeof scope?.sessionId === "string" ? scope.sessionId : undefined;
    if (!directory || !harnessId || !sessionId) return;
    this.requestDispatch({ directory, harnessId, sessionId });
  }

  private requestDispatch(input: {
    directory: string;
    harnessId: string;
    sessionId: string;
    session?: SessionRecord;
  }): void {
    const key = queueDispatchKey(input);
    if (this.dispatching.has(key)) return;
    this.dispatching.add(key);

    void this.dispatch(input)
      .catch((error) => {
        if (isBusyDispatchError(error)) return;
        this.input.services.events.emit(
          "runtime.error",
          {
            message: "Failed to dispatch queued prompt",
            error: error instanceof Error ? error.message : String(error),
          },
          {
            directory: input.directory,
            sessionId: input.sessionId,
            harnessId: input.harnessId,
          },
        );
      })
      .finally(() => this.dispatching.delete(key));
  }

  private async dispatch(input: {
    directory: string;
    harnessId: string;
    sessionId: string;
    session?: SessionRecord;
  }): Promise<void> {
    const session =
      input.session ??
      (await resolveSessionRecordForMutation({
        services: this.input.services,
        sessionId: input.sessionId,
        scope: {
          directory: input.directory,
          harnessId: input.harnessId as SessionRecord["harnessId"],
        },
        resolveSafeDirectory: this.input.resolveSafeDirectory,
      }));
    const scopeRef = await resolveSessionDirectoryScope({
      session,
      resolveSafeDirectory: this.input.resolveSafeDirectory,
    });
    await dispatchFirstQueuedPrompt({
      services: this.input.services,
      scopeRef,
      session,
    });
  }
}
