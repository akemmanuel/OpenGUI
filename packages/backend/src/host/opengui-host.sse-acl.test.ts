import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { DurableActor, ExecutionPolicy, ModelTransport } from "@opengui/harness";
import { OpenGuiHost, type HostEvent, type SessionAccessGate } from "./opengui-host.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("OpenGuiHost Session ACL event isolation", () => {
  test("a subscription admitted before close cannot attach to a restarted Host", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-subscribe-close-"));
    temporaryDirectories.push(root);
    let markReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy: ExecutionPolicy = {
      restricted: false,
      revision: 1,
      shellAllowed: true,
      async authorizePath(path) {
        return { allowed: true, canonicalPath: path };
      },
    };
    const host = new OpenGuiHost(root, {
      resolveExecutionPolicy: async () => {
        markReached();
        await blocked;
        return policy;
      },
    });
    await host.start();

    const subscribing = host.subscribe(undefined, undefined, () => undefined);
    await reached;
    await host.close();
    await host.start();
    release();

    await expect(subscribing).rejects.toThrow("not started");
    await host.close();
  });

  test("a global subscriber receives its own private Session events but not another user's", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-sse-acl-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);

    const ada: DurableActor = { type: "user", id: "ada", displayName: "Ada" };
    const grace: DurableActor = { type: "user", id: "grace", displayName: "Grace" };
    const owners = new Map<string, string>();
    const access: SessionAccessGate = {
      async onCreated(sessionId, actor) {
        owners.set(sessionId, actor.id);
      },
      async onDeleted(sessionId) {
        owners.delete(sessionId);
      },
      async authorize(sessionId, actor) {
        if (!actor || owners.get(sessionId) !== actor.id) throw new Error("Session not found");
      },
      async filterList(sessionIds, actor) {
        return sessionIds.filter((sessionId) => owners.get(sessionId) === actor?.id);
      },
    };
    const model: ModelTransport = {
      async *stream() {
        yield { type: "text_delta", delta: "fixture response" };
        yield { type: "completed" };
      },
    };
    const host = new OpenGuiHost(root, { sessionAccess: access, model });
    await host.start();
    await host.upsertModelConnection({
      id: "offline",
      label: "Offline",
      baseUrl: "http://offline.test/v1",
      modelIds: ["test-model"],
    });
    const adaSession = await host.createSession(
      {
        projectDirectory: project,
        model: { connectionId: "offline", modelId: "test-model" },
        reasoning: "none",
      },
      ada,
    );
    const graceSession = await host.createSession(
      {
        projectDirectory: project,
        model: { connectionId: "offline", modelId: "test-model" },
        reasoning: "none",
      },
      grace,
    );
    const adaEvents: HostEvent[] = [];
    const graceEvents: HostEvent[] = [];
    const unsubscribeAda = await host.subscribe(ada, undefined, (event) => {
      adaEvents.push(event);
    });
    const unsubscribeGrace = await host.subscribe(grace, undefined, (event) => {
      graceEvents.push(event);
    });

    await host.prompt(adaSession.id, { text: "Ada private", actor: ada });
    await host.prompt(graceSession.id, { text: "Grace private", actor: grace });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(new Set(adaEvents.map((event) => event.sessionId))).toEqual(new Set([adaSession.id]));
    expect(new Set(graceEvents.map((event) => event.sessionId))).toEqual(
      new Set([graceSession.id]),
    );

    unsubscribeAda();
    unsubscribeGrace();
    await host.close();
  });

  test("asynchronous ACL checks preserve event order for each subscriber", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-sse-order-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const actor: DurableActor = { type: "user", id: "ada", displayName: "Ada" };
    let authorizationCount = 0;
    const access: SessionAccessGate = {
      async onCreated() {},
      async onDeleted() {},
      async authorize() {
        authorizationCount += 1;
        // The first check is prompt admission; delay the first emitted event.
        if (authorizationCount === 2) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      },
      async filterList(sessionIds) {
        return sessionIds;
      },
    };
    const model: ModelTransport = {
      async *stream() {
        yield { type: "text_delta", delta: "fixture response" };
        yield { type: "completed" };
      },
    };
    const host = new OpenGuiHost(root, { sessionAccess: access, model });
    await host.start();
    await host.upsertModelConnection({
      id: "offline",
      label: "Offline",
      baseUrl: "http://offline.test/v1",
      modelIds: ["test-model"],
    });
    const session = await host.createSession(
      {
        projectDirectory: project,
        model: { connectionId: "offline", modelId: "test-model" },
        reasoning: "none",
      },
      actor,
    );
    const events: HostEvent[] = [];
    const unsubscribe = await host.subscribe(actor, undefined, (event) => {
      events.push(event);
    });

    await host.prompt(session.id, { text: "ordered", actor });
    await host.waitForIdle(session.id, actor);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(
      events.flatMap(({ event }) =>
        event.type === "entry_appended" ? [event.entry.kind] : [event.type],
      ),
    ).toEqual([
      "user_message",
      "run_started",
      "assistant_delta",
      "assistant_message",
      "run_completed",
    ]);
    unsubscribe();
    await host.close();
  });

  test("unsubscribe during dispatch drops queued events and listener errors do not poison peers", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-sse-unsubscribe-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const model: ModelTransport = {
      async *stream() {
        yield { type: "text_delta", delta: "fixture" };
        yield { type: "completed" };
      },
    };
    const host = new OpenGuiHost(root, { model });
    await host.start();
    const session = await host.createSession({
      projectDirectory: project,
      model: { connectionId: "offline", modelId: "fixture-model" },
      reasoning: "none",
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirst!: () => void;
    const firstReached = new Promise<void>((resolve) => {
      markFirst = resolve;
    });
    const leavingEvents: HostEvent[] = [];
    const peerEvents: HostEvent[] = [];
    const unsubscribeLeaving = await host.subscribe(undefined, session.id, async (event) => {
      leavingEvents.push(event);
      if (leavingEvents.length === 1) {
        markFirst();
        await firstBlocked;
      }
    });
    const unsubscribeThrowing = await host.subscribe(undefined, session.id, () => {
      throw new Error("disconnected listener");
    });
    const unsubscribePeer = await host.subscribe(undefined, session.id, (event) => {
      peerEvents.push(event);
    });

    await host.prompt(session.id, { text: "dispatch" });
    await firstReached;
    unsubscribeLeaving();
    releaseFirst();
    await host.waitForIdle(session.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(leavingEvents).toHaveLength(1);
    expect(peerEvents.map(({ event }) => event.type)).toEqual([
      "entry_appended",
      "entry_appended",
      "assistant_delta",
      "entry_appended",
      "entry_appended",
    ]);
    unsubscribeThrowing();
    unsubscribePeer();
    await host.close();
  });
});
