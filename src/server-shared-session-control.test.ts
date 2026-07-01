import { describe, expect, test } from "vite-plus/test";
import type { DirectoryScopeRef } from "@opengui/runtime";
import { BackendEventBus } from "../server/services/event-bus.ts";
import type { BackendServiceContext, SessionRecord } from "../server/services/index.ts";
import {
  registerSharedSessionControl,
  sendQueuedPromptNow,
} from "../server/services/shared-session-control.ts";

function makeSession(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "opencode:s1",
    rawId: "s1",
    directory: "/repo",
    harnessId: "opencode",
    title: "Session",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function directoryRef(path: string): DirectoryScopeRef {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: path,
    displayName: path,
    path,
    canonicalPath: path,
    createdAt: now,
    updatedAt: now,
  };
}

function makeServices(input: {
  session?: SessionRecord;
  prompt?: () => Promise<void>;
  abort?: () => Promise<void>;
}) {
  const session = input.session ?? makeSession();
  const queue = [
    {
      id: "queue-1",
      sessionId: session.id,
      text: "queued work",
      createdAt: 1,
      mode: "queue",
    },
  ];
  const prompts: unknown[] = [];
  const aborts: unknown[] = [];
  const services = {
    events: new BackendEventBus(),
    sessions: {
      getSession: async () => session,
    },
    queues: {
      listSessionQueue: async () => queue,
      remove: async (_sessionId: string, entryId: string) => {
        const index = queue.findIndex((entry) => entry.id === entryId);
        if (index !== -1) queue.splice(index, 1);
        return queue;
      },
      reorder: async () => queue,
    },
    harnesses: {
      promptSession: async (call: unknown) => {
        prompts.push(call);
        await input.prompt?.();
      },
      abortSession: async (call: unknown) => {
        aborts.push(call);
        await input.abort?.();
      },
    },
  } as unknown as BackendServiceContext;
  return { services, session, queue, prompts, aborts };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("shared Queue dispatch", () => {
  test("dispatches the first queued prompt when live session stream finishes", async () => {
    const { services, queue, prompts } = makeServices({
      session: makeSession({ status: "running" }),
    });
    const unregister = registerSharedSessionControl({
      services,
      resolveSafeDirectory: async (path) => path,
    });

    services.events.publish("run.finished", {
      type: "run.finished",
      scope: { directory: "/repo", harnessId: "opencode", sessionId: "opencode:s1" },
      reason: "idle",
    });
    await tick();
    unregister();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ text: "queued work" });
    expect(queue).toEqual([]);
  });

  test("deduplicates live-finished and session-idle dispatch signals", async () => {
    let releasePrompt!: () => void;
    const promptBlocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const { services, session, prompts } = makeServices({
      session: makeSession({ status: "idle" }),
      prompt: async () => promptBlocked,
    });
    const unregister = registerSharedSessionControl({
      services,
      resolveSafeDirectory: async (path) => path,
    });

    services.events.publish("run.finished", {
      type: "run.finished",
      scope: { directory: "/repo", harnessId: "opencode", sessionId: "opencode:s1" },
      reason: "idle",
    });
    services.events.emit(
      "session.updated",
      { sessionId: session.id, session },
      {
        directory: "/repo",
        harnessId: "opencode",
        sessionId: session.id,
      },
    );
    await tick();
    releasePrompt();
    await tick();
    unregister();

    expect(prompts).toHaveLength(1);
  });

  test("send-now does not get stuck when cached Session status is stale running", async () => {
    const { services, session, queue, prompts, aborts } = makeServices({
      session: makeSession({ status: "running" }),
    });

    await sendQueuedPromptNow({
      services,
      scopeRef: directoryRef("/repo"),
      session,
      entryId: "queue-1",
    });

    expect(aborts).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(queue).toEqual([]);
  });

  test("keeps queued prompt when dispatch reports the Session is still busy", async () => {
    const { services, session, queue, prompts } = makeServices({
      session: makeSession({ status: "running" }),
      prompt: async () => {
        throw new Error("Session is busy");
      },
    });

    await sendQueuedPromptNow({
      services,
      scopeRef: directoryRef("/repo"),
      session,
      entryId: "queue-1",
    });

    expect(prompts).toHaveLength(1);
    expect(queue).toHaveLength(1);
  });
});
