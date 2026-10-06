import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  createOpenGuiHarness,
  type DurableActor,
  type ExecutionPolicy,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelTransport,
  ModelTransportError,
  type ProviderResponseMetadata,
  type SessionEntry,
  type SessionEvent,
} from "../index.ts";
import { SqliteSessionStore } from "../storage/sqlite-store.ts";
import { FakeClock, SequenceIdGenerator } from "../test/index.ts";

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "opengui-compaction-recovery-"));
}

function containsPath(root: string, candidate: string) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

/** Harmless local stand-in for Host path-grant enforcement: project-scoped, deny-by-default. */
function projectScopedPolicy(
  root: string,
  input?: { revision?: number; revoked?: () => boolean },
): ExecutionPolicy {
  return {
    restricted: true,
    revision: input?.revision ?? 1,
    shellAllowed: false,
    async authorizePath(path, access, options = {}) {
      void access;
      void options;
      if (input?.revoked?.()) return { allowed: false, reason: "outside_grants" };
      const target = resolve(path);
      if (!containsPath(root, target)) return { allowed: false, reason: "outside_grants" };
      return { allowed: true, canonicalPath: target };
    },
  };
}

type HandoffMode =
  | "valid"
  | "prose"
  | "providerRateLimit"
  | "providerTransportFailure"
  | "hangOnHandoff";

const FAILURE_RESPONSE: ProviderResponseMetadata = {
  responseId: "resp-compaction-1",
  provider: "fixture",
  api: "fixture-api",
  model: "fixture-model",
  protocol: "openai-chat",
  usage: { input: 120, output: 45, cacheRead: 0, cacheWrite: 0, total: 165 },
  stopReason: "error",
  cache: { generation: "gen-1", readTokens: 0, writeTokens: 0 },
  timing: { startedAt: "2026-07-10T10:00:00.000Z", completedMs: 12, attempts: 1 },
};

const SUMMARY = (goal: string) => ({
  goal,
  currentState: "Fixture work is partially done.",
  constraints: "Stay inside the fixture project.",
  decisions: "Single summary response.",
  blockers: "None.",
  relevantFiles: ["README.md"],
  nextSteps: ["Continue from the summary."],
});

/** Deterministic fixture: long first task answer, one JSON summary per handoff turn. */
class RecoveryHandoffModel implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  #taskTurns = 0;
  constructor(
    public mode: HandoffMode = "valid",
    readonly goal = "Continue the fixture task.",
  ) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    if (signal.aborted) throw signal.reason;
    this.requests.push(structuredClone(request));
    const last = request.context.at(-1);
    const isHandoffTurn =
      last?.type === "user_message" && last.text.includes("CONTEXT HANDOFF MODE");
    const first = request.context[0];
    const isResume =
      first?.type === "user_message" &&
      typeof first.text === "string" &&
      first.text.includes("HISTORICAL CONTEXT");

    if (isHandoffTurn) {
      if (this.mode === "hangOnHandoff") {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
        return;
      }
      if (this.mode === "providerRateLimit") {
        throw Object.assign(new Error("usage_limit exceeded for the test model"), {
          status: 429,
        });
      }
      if (this.mode === "providerTransportFailure") {
        throw new ModelTransportError(
          {
            code: "rate_limit",
            message: "Model provider rate limit reached",
            detail: "usage_limit exceeded",
            retryable: true,
            status: 429,
          },
          FAILURE_RESPONSE,
        );
      }
      if (this.mode === "prose") {
        yield { type: "text_delta", delta: "# Handoff\n\nJust continue the work.\n" };
      } else {
        yield { type: "text_delta", delta: JSON.stringify(SUMMARY(this.goal)) };
      }
      yield { type: "completed" };
      return;
    }

    this.#taskTurns += 1;
    yield {
      type: "text_delta",
      delta: isResume
        ? `Resumed: ${this.goal}`
        : this.#taskTurns === 1
          ? `Long work state ${"x".repeat(1_000)}`
          : "Task answer.",
    };
    yield { type: "completed" };
  }
}

const MEMBER: DurableActor = { type: "user", id: "member-1", displayName: "Member One" };

async function setupRestricted(input?: {
  mode?: HandoffMode;
  goal?: string;
  contextWindowTokens?: number;
  revoked?: () => boolean;
}) {
  const dataDirectory = await temporaryDirectory();
  const projectDirectory = join(dataDirectory, "project");
  const homeDirectory = join(dataDirectory, "home");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(homeDirectory, { recursive: true });
  const canonicalProject = await realpath(projectDirectory);
  const model = new RecoveryHandoffModel(input?.mode ?? "valid", input?.goal);
  const harness = createOpenGuiHarness({
    dataDirectory,
    homeDirectory,
    model,
    clock: new FakeClock("2026-07-10T10:00:00.000Z"),
    ids: new SequenceIdGenerator(),
    compaction: {
      contextWindowTokens: input?.contextWindowTokens ?? 10_000,
      thresholdRatio: 0.7,
    },
    resolveExecutionPolicy: async () => projectScopedPolicy(canonicalProject, input),
  });
  const session = await harness.createSession({
    projectDirectory,
    model: { connectionId: "fake", modelId: "fake-model" },
    reasoning: "none",
  });
  return {
    dataDirectory,
    projectDirectory,
    homeDirectory,
    canonicalProject,
    model,
    harness,
    session,
  };
}

async function drain(events: AsyncIterable<unknown>) {
  for await (const _event of events) {
    // drain
  }
}

function handoffAttempts(model: RecoveryHandoffModel) {
  return model.requests.filter((request) =>
    request.context.some(
      (item) => item.type === "user_message" && item.text.includes("CONTEXT HANDOFF MODE"),
    ),
  ).length;
}

function taskTurns(model: RecoveryHandoffModel) {
  return model.requests.filter(
    (request) =>
      !request.context.some(
        (item) => item.type === "user_message" && item.text.includes("CONTEXT HANDOFF MODE"),
      ),
  ).length;
}

function lastRunFailed(entries: SessionEntry[]) {
  const failed = entries.filter((entry) => entry.kind === "run_failed");
  return failed.at(-1);
}

function failedCompactions(entries: SessionEntry[]) {
  return entries.filter(
    (entry) => entry.kind === "compaction" && entry.payload.status === "failed",
  );
}

describe("compaction failure recovery (issue #151, Harness seam)", () => {
  test("invalid summaries record a failed outcome with compaction classification", async () => {
    const { harness, session, model } = await setupRestricted({
      mode: "prose",
      contextWindowTokens: 300,
    });
    try {
      for await (const _event of session.run({
        text: "Start the long task",
        actor: MEMBER,
        skills: [],
      })) {
        // drain — long first answer pushes the next prompt over threshold
      }
      await expect(
        drain(session.run({ text: "Trigger compaction", actor: MEMBER })),
      ).rejects.toThrow("Compaction summary was invalid");

      const snapshot = await session.read();
      const failed = failedCompactions(snapshot.entries);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({
        status: "failed",
        failureSource: "summary",
        reason: "threshold",
      });
      const runFailed = lastRunFailed(snapshot.entries);
      expect(runFailed?.payload.normalizedError).toMatchObject({
        code: "compaction",
        retryable: false,
      });
      expect(runFailed?.payload.normalizedError).not.toMatchObject({
        message: "Model provider request failed",
      });
      expect(handoffAttempts(model)).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test("genuine provider failures keep true codes and still record the failed outcome", async () => {
    const { harness, session, model } = await setupRestricted({
      mode: "providerRateLimit",
      contextWindowTokens: 300,
    });
    try {
      for await (const _event of session.run({
        text: "Start the long task",
        actor: MEMBER,
        skills: [],
      })) {
        // drain
      }
      await expect(
        drain(session.run({ text: "Trigger compaction", actor: MEMBER })),
      ).rejects.toThrow();

      const snapshot = await session.read();
      expect(failedCompactions(snapshot.entries)).toHaveLength(1);
      expect(failedCompactions(snapshot.entries)[0]?.payload).toMatchObject({
        failureSource: "provider",
      });
      expect(lastRunFailed(snapshot.entries)?.payload.normalizedError).toMatchObject({
        code: "rate_limit",
      });

      // A later prompt must not automatically retry the failed compaction.
      const requestsBefore = model.requests.length;
      await drain(session.run({ text: "Second trigger", actor: MEMBER }));
      expect(handoffAttempts(model)).toBe(1);
      expect(model.requests.length).toBe(requestsBefore);
      expect(lastRunFailed((await session.read()).entries)?.payload).toMatchObject({
        recoveryRequired: true,
      });
    } finally {
      await harness.close();
    }
  });

  test("two successive prompts cause exactly one automatic compaction attempt", async () => {
    const { harness, session, model } = await setupRestricted({
      mode: "prose",
      contextWindowTokens: 300,
    });
    try {
      for await (const _event of session.run({
        text: "Start the long task",
        actor: MEMBER,
        skills: [],
      })) {
        // drain
      }
      await drain(session.run({ text: "First trigger", actor: MEMBER })).catch(() => undefined);
      expect(handoffAttempts(model)).toBe(1);
      const taskTurnsBefore = taskTurns(model);

      // Blocked: no model invocation, recovery-required outcome, intent preserved once.
      await drain(session.run({ text: "Second trigger", actor: MEMBER }));
      expect(handoffAttempts(model)).toBe(1);
      expect(taskTurns(model)).toBe(taskTurnsBefore);
      const snapshot = await session.read();
      expect(lastRunFailed(snapshot.entries)?.payload).toMatchObject({
        recoveryRequired: true,
        error: "Compaction needs attention before continuing",
        normalizedError: { code: "compaction", retryable: false },
      });
      expect(
        snapshot.entries
          .filter((entry) => entry.kind === "user_message")
          .map((entry) => entry.payload.text),
      ).toEqual(["Start the long task", "First trigger", "Second trigger"]);
    } finally {
      await harness.close();
    }
  });

  test("restart preserves suppression without invoking the model", async () => {
    const { harness, session, model, dataDirectory } = await setupRestricted({
      mode: "prose",
      contextWindowTokens: 300,
    });
    try {
      for await (const _event of session.run({
        text: "Start the long task",
        actor: MEMBER,
        skills: [],
      })) {
        // drain
      }
      await drain(session.run({ text: "Trigger compaction", actor: MEMBER })).catch(
        () => undefined,
      );
      expect(handoffAttempts(model)).toBe(1);
      const sessionId = (await session.read()).id;
      await harness.close();

      const reopenedModel = new RecoveryHandoffModel("prose");
      const reopened = createOpenGuiHarness({
        dataDirectory,
        homeDirectory: join(dataDirectory, "home"),
        model: reopenedModel,
        clock: new FakeClock("2026-07-10T10:00:00.000Z"),
        ids: new SequenceIdGenerator(100),
        compaction: { contextWindowTokens: 300 },
        resolveExecutionPolicy: async () =>
          projectScopedPolicy(await realpath(join(dataDirectory, "project"))),
      });
      try {
        const same = await reopened.openSession(sessionId);
        await drain(same.run({ text: "After restart", actor: MEMBER }));
        expect(handoffAttempts(reopenedModel)).toBe(0);
        expect(taskTurns(reopenedModel)).toBe(0);
        expect(lastRunFailed((await same.read()).entries)?.payload).toMatchObject({
          recoveryRequired: true,
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await harness.close().catch(() => undefined);
    }
  });

  test("explicit retry while revoked stays denied; success unlocks continuation", async () => {
    let revoked = false;
    const { harness, session, model } = await setupRestricted({
      mode: "prose",
      contextWindowTokens: 300,
      revoked: () => revoked,
    });
    try {
      for await (const _event of session.run({
        text: "Start the long task",
        actor: MEMBER,
        skills: [],
      })) {
        // drain
      }
      await drain(session.run({ text: "Trigger compaction", actor: MEMBER })).catch(
        () => undefined,
      );
      expect(failedCompactions((await session.read()).entries)).toHaveLength(1);

      // Explicit retry while revoked: denied, still blocked, nothing published.
      revoked = true;
      model.mode = "valid";
      await drain(session.compact(MEMBER));
      const denied = await session.read();
      expect(denied.entries.at(-1)).toMatchObject({
        kind: "run_failed",
        payload: { error: expect.stringContaining("denied") },
      });
      expect(failedCompactions(denied.entries)).toHaveLength(1);
      const attemptsBefore = handoffAttempts(model);
      await drain(session.run({ text: "Still blocked", actor: MEMBER }));
      expect(handoffAttempts(model)).toBe(attemptsBefore);

      // Re-grant and retry explicitly: success releases the block in place.
      revoked = false;
      await drain(session.compact(MEMBER));
      expect(
        (await session.read()).entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => entry.payload.status),
      ).toEqual(["started", "failed", "started", "completed"]);
      await drain(session.run({ text: "Continue after recovery", actor: MEMBER }));
      const resume = model.requests.find((request) =>
        request.context.some(
          (item) => item.type === "user_message" && item.text.includes("HISTORICAL CONTEXT"),
        ),
      );
      expect(resume?.context[0]).toMatchObject({
        text: expect.stringContaining("Continue the fixture task."),
      });
    } finally {
      await harness.close();
    }
  });

  test("blocked prompts preserve history, project work, and queued follow-ups exactly once", async () => {
    const { harness, session, model, projectDirectory } = await setupRestricted({
      mode: "prose",
      contextWindowTokens: 300,
    });
    try {
      const { writeFile, readFile } = await import("node:fs/promises");
      await writeFile(join(projectDirectory, "work.txt"), "accepted work");
      for await (const _event of session.run({
        text: "Start the long task",
        actor: MEMBER,
        skills: [],
      })) {
        // drain
      }
      // Queue a follow-up mid-run; the failing run must leave it queued.
      const iterator = session
        .run({ text: "Trigger compaction", actor: MEMBER })
        [Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
      await session.followUp({ text: "Queued while failing", actor: MEMBER });
      await (async () => {
        try {
          while (!(await iterator.next()).done) {
            // drain the failing run
          }
        } catch {
          // The invalid summary failure is expected here.
        }
      })();
      expect((await session.read()).followUps.map((item) => item.prompt.text)).toEqual([
        "Queued while failing",
      ]);

      // Blocked prompt: follow-up stays queued, nothing duplicated.
      await drain(session.run({ text: "Second trigger", actor: MEMBER }));
      expect((await session.read()).followUps.map((item) => item.prompt.text)).toEqual([
        "Queued while failing",
      ]);

      // Unlock explicitly, then the next prompt answers and dispatches the queue once.
      model.mode = "valid";
      await drain(session.compact(MEMBER));
      await drain(session.run({ text: "Continue after recovery", actor: MEMBER }));
      const after = await session.read();
      expect(after.followUps).toEqual([]);
      expect(
        after.entries
          .filter((entry) => entry.kind === "user_message")
          .map((entry) => entry.payload.text),
      ).toEqual([
        "Start the long task",
        "Trigger compaction",
        "Second trigger",
        "Continue after recovery",
        "Queued while failing",
      ]);
      expect(await readFile(join(projectDirectory, "work.txt"), "utf8")).toBe("accepted work");
    } finally {
      await harness.close();
    }
  });

  test("aborting compaction stays aborted without locking future attempts", async () => {
    const { harness, session, model } = await setupRestricted({
      mode: "hangOnHandoff",
      contextWindowTokens: 300,
    });
    try {
      for await (const _event of session.run({
        text: "Start the long task",
        actor: MEMBER,
        skills: [],
      })) {
        // drain
      }
      const iterator = session.compact(MEMBER)[Symbol.asyncIterator]();
      await iterator.next();
      await session.abort();
      while (!(await iterator.next()).done) {
        // drain the terminal run event; abort resolves without rethrowing
      }
      const snapshot = await session.read();
      expect(snapshot.entries.at(-1)?.kind).toBe("run_aborted");
      expect(failedCompactions(snapshot.entries)).toHaveLength(0);

      // Intentional abort does not force the retry lock: the next over-threshold
      // prompt attempts compaction again.
      model.mode = "valid";
      await drain(session.run({ text: "Try again after abort", actor: MEMBER }));
      expect(handoffAttempts(model)).toBe(1);
      expect(
        (await session.read()).entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => entry.payload.status),
      ).toContain("completed");
    } finally {
      await harness.close();
    }
  });

  test("unrecordable failure still blocks via started plus run_failed fallback", async () => {
    const { harness, session, model } = await setupRestricted({
      contextWindowTokens: 300,
    });
    try {
      for await (const _event of session.run({
        text: "Start the long task",
        actor: MEMBER,
        skills: [],
      })) {
        // drain
      }
      // Fail persistence of the terminal outcomes only: the started entry plus
      // the outer run_failed remain, with no failed entry recorded.
      const storePrototype = SqliteSessionStore.prototype;
      const originalDescriptor = Object.getOwnPropertyDescriptor(storePrototype, "appendEntry");
      if (!originalDescriptor?.value) throw new Error("appendEntry descriptor not found");
      const originalAppendEntry = originalDescriptor.value as typeof storePrototype.appendEntry;
      storePrototype.appendEntry = async function (
        this: SqliteSessionStore,
        sessionId: string,
        kind: SessionEntry["kind"],
        payload: Record<string, unknown>,
        now: string,
      ) {
        if (
          kind === "compaction" &&
          (payload.status === "completed" || payload.status === "failed")
        ) {
          throw new Error("injected terminal-outcome storage failure");
        }
        return originalAppendEntry.call(this, sessionId, kind, payload, now);
      };
      try {
        await expect(
          drain(session.run({ text: "Trigger compaction", actor: MEMBER })),
        ).rejects.toThrow("Compaction summary could not be saved");
      } finally {
        Object.defineProperty(storePrototype, "appendEntry", originalDescriptor);
      }

      const snapshot = await session.read();
      expect(failedCompactions(snapshot.entries)).toHaveLength(0);
      expect(
        snapshot.entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => [entry.payload.status, entry.payload.runId]),
      ).toEqual([["started", lastRunFailed(snapshot.entries)?.payload.runId]]);

      // The next prompt is blocked by the fallback, without model invocation.
      const requestsBefore = model.requests.length;
      await drain(session.run({ text: "Second trigger", actor: MEMBER }));
      expect(model.requests.length).toBe(requestsBefore);
      expect(lastRunFailed((await session.read()).entries)?.payload).toMatchObject({
        recoveryRequired: true,
      });

      // Explicit retry succeeds and releases the block in place.
      await drain(session.compact(MEMBER));
      expect(
        (await session.read()).entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => entry.payload.status),
      ).toContain("completed");
    } finally {
      await harness.close();
    }
  });

  test("failed manual compaction emits the failed entry to live subscribers", async () => {
    const { harness, session } = await setupRestricted({ mode: "prose" });
    try {
      for await (const _event of session.run({ text: "Do work", actor: MEMBER, skills: [] })) {
        // drain
      }
      const emitted: SessionEvent[] = [];
      await (async () => {
        try {
          for await (const event of session.compact(MEMBER)) emitted.push(event);
        } catch {
          // The invalid summary failure is expected here.
        }
      })();
      const emittedFailed = emitted.filter(
        (event) =>
          event.type === "entry_appended" &&
          event.entry.kind === "compaction" &&
          event.entry.payload.status === "failed",
      );
      expect(emittedFailed).toHaveLength(1);
      const durableFailed = failedCompactions((await session.read()).entries);
      expect(durableFailed).toHaveLength(1);
      expect(emittedFailed[0]).toMatchObject({
        type: "entry_appended",
        entry: { id: durableFailed[0]?.id },
      });
    } finally {
      await harness.close();
    }
  });

  test("failed threshold compaction emits the failed entry to live subscribers", async () => {
    const { harness, session } = await setupRestricted({
      mode: "prose",
      contextWindowTokens: 300,
    });
    try {
      for await (const _event of session.run({
        text: "Start the long task",
        actor: MEMBER,
        skills: [],
      })) {
        // drain
      }
      const emitted: SessionEvent[] = [];
      await expect(
        (async () => {
          for await (const event of session.run({ text: "Trigger compaction", actor: MEMBER })) {
            emitted.push(event);
          }
        })(),
      ).rejects.toThrow("Compaction summary was invalid");
      const emittedFailed = emitted.filter(
        (event) =>
          event.type === "entry_appended" &&
          event.entry.kind === "compaction" &&
          event.entry.payload.status === "failed",
      );
      expect(emittedFailed).toHaveLength(1);
      const durableFailed = failedCompactions((await session.read()).entries);
      expect(durableFailed).toHaveLength(1);
      expect(emittedFailed[0]).toMatchObject({
        type: "entry_appended",
        entry: { id: durableFailed[0]?.id },
      });
    } finally {
      await harness.close();
    }
  });

  test("failed provider transport preserves response telemetry on manual compact", async () => {
    const { harness, session } = await setupRestricted({ mode: "providerTransportFailure" });
    try {
      for await (const _event of session.run({ text: "Do work", actor: MEMBER, skills: [] })) {
        // drain
      }
      const emitted: SessionEvent[] = [];
      await (async () => {
        try {
          for await (const event of session.compact(MEMBER)) emitted.push(event);
        } catch {
          // The provider failure is expected here.
        }
      })();
      const snapshot = await session.read();
      const responses = snapshot.entries.filter(
        (entry) => entry.kind === "provider_response" && entry.payload.purpose === "compaction",
      );
      expect(responses).toHaveLength(1);
      expect(responses[0]?.payload.response).toMatchObject({
        responseId: "resp-compaction-1",
        usage: expect.objectContaining({ input: 120, output: 45, total: 165 }),
      });
      expect(failedCompactions(snapshot.entries)[0]?.payload).toMatchObject({
        failureSource: "provider",
      });
      const emittedResponses = emitted.filter(
        (event) =>
          event.type === "entry_appended" &&
          event.entry.kind === "provider_response" &&
          event.entry.payload.purpose === "compaction",
      );
      expect(emittedResponses).toHaveLength(1);
      expect(emittedResponses[0]).toMatchObject({
        type: "entry_appended",
        entry: { id: responses[0]?.id },
      });
    } finally {
      await harness.close();
    }
  });

  test("failed provider transport preserves code and telemetry on threshold runs", async () => {
    const { harness, session } = await setupRestricted({
      mode: "providerTransportFailure",
      contextWindowTokens: 300,
    });
    try {
      for await (const _event of session.run({
        text: "Start the long task",
        actor: MEMBER,
        skills: [],
      })) {
        // drain
      }
      await expect(
        drain(session.run({ text: "Trigger compaction", actor: MEMBER })),
      ).rejects.toThrow("Model provider rate limit reached");
      const snapshot = await session.read();
      const responses = snapshot.entries.filter(
        (entry) => entry.kind === "provider_response" && entry.payload.purpose === "compaction",
      );
      expect(responses).toHaveLength(1);
      expect(responses[0]?.payload.response).toMatchObject({
        responseId: "resp-compaction-1",
        usage: expect.objectContaining({ total: 165 }),
      });
      expect(lastRunFailed(snapshot.entries)?.payload.normalizedError).toMatchObject({
        code: "rate_limit",
        status: 429,
      });
    } finally {
      await harness.close();
    }
  });
});
