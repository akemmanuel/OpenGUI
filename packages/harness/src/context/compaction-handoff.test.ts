import { mkdir, mkdtemp, realpath, readFile } from "node:fs/promises";
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
  type SessionEntry,
} from "../index.ts";
import type { ProviderResponseMetadata } from "../models/transport.ts";
import { buildModelContext } from "./build-context.ts";
import { MAX_HANDOFF_BYTES } from "./compaction.ts";
import { SqliteSessionStore } from "../storage/sqlite-store.ts";
import { FakeClock, SequenceIdGenerator } from "../test/index.ts";

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "opengui-compaction-pra-"));
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
  | "empty"
  | "oversized"
  | "incomplete"
  | "truncated"
  | "compactionToolCall"
  | "hangOnHandoff"
  | "sessionGoal"
  | "outsideTaskWrite";

const SUMMARY_RESPONSE: ProviderResponseMetadata = {
  provider: "fixture",
  api: "fixture",
  model: "fake-model",
  protocol: "openai-chat",
  usage: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0, total: 130 },
  stopReason: "stop",
  cache: { generation: "fixture", readTokens: 0, writeTokens: 0 },
  timing: { startedAt: "2026-10-06T00:00:00.000Z", completedMs: 1, attempts: 1 },
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

/**
 * Deterministic model fixture for the tool-free JSON handoff. Task turns answer
 * text (long on the first turn so a small threshold triggers on the next
 * prompt); compaction turns return one JSON response per mode.
 */
class JsonHandoffModel implements ModelTransport {
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
      switch (this.mode) {
        case "prose":
          yield { type: "text_delta", delta: "# Handoff\n\nJust continue the work.\n" };
          break;
        case "empty":
          yield { type: "text_delta", delta: "   \n" };
          break;
        case "oversized":
          yield {
            type: "text_delta",
            delta: JSON.stringify({ ...SUMMARY(this.goal), decisions: "x".repeat(100_000) }),
          };
          break;
        case "compactionToolCall":
          yield {
            type: "tool_call",
            id: "rogue-write",
            name: "write",
            input: { path: "should-never-exist.txt", content: "rogue" },
          };
          break;
        case "sessionGoal":
          yield {
            type: "text_delta",
            delta: JSON.stringify(SUMMARY(`Goal for ${request.identity?.sessionId}`)),
          };
          break;
        default:
          yield { type: "text_delta", delta: JSON.stringify(SUMMARY(this.goal)) };
          break;
      }
      if (this.mode === "incomplete") return;
      yield {
        type: "completed",
        response: {
          ...SUMMARY_RESPONSE,
          stopReason: this.mode === "truncated" ? "length" : "stop",
        },
      };
      return;
    }

    if (this.mode === "outsideTaskWrite" && this.#taskTurns === 0) {
      this.#taskTurns += 1;
      yield {
        type: "tool_call",
        id: "outside-write",
        name: "write",
        input: { path: join(request.projectDirectory, "..", "outside.txt"), content: "no" },
      };
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
  customInstructions?: (actor: DurableActor | undefined) => string | undefined;
}) {
  const dataDirectory = await temporaryDirectory();
  const projectDirectory = join(dataDirectory, "project");
  const homeDirectory = join(dataDirectory, "home");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(homeDirectory, { recursive: true });
  const canonicalProject = await realpath(projectDirectory);
  const model = new JsonHandoffModel(input?.mode ?? "valid", input?.goal);
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
    ...(input?.customInstructions
      ? {
          resolveCustomInstructions: async ({ actor }: { actor?: DurableActor }) =>
            input.customInstructions!(actor),
        }
      : {}),
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

function handoffTurns(model: JsonHandoffModel) {
  return model.requests.filter((request) =>
    request.context.some(
      (item) => item.type === "user_message" && item.text.includes("CONTEXT HANDOFF MODE"),
    ),
  );
}

describe("compaction handoff (issue #150, Harness seam)", () => {
  test("restricted manual compaction succeeds and the next turn continues the task", async () => {
    const { harness, session, model } = await setupRestricted();
    try {
      for await (const _event of session.run({
        text: "Do harmless fixture work",
        actor: MEMBER,
        skills: [],
      })) {
        // drain
      }
      await drain(session.compact(MEMBER));

      const snapshot = await session.read();
      const compactions = snapshot.entries.filter((entry) => entry.kind === "compaction");
      expect(compactions.map((entry) => entry.payload.status)).toEqual(["started", "completed"]);
      expect(compactions.at(-1)?.payload.handoff).toContain("Continue the fixture task.");
      expect(compactions.at(-1)?.payload).not.toHaveProperty("handoffDirectory");
      expect(compactions.at(-1)?.payload).not.toHaveProperty("handoffPath");

      // No normal Tool entries were executed for compaction storage.
      expect(
        snapshot.entries.filter(
          (entry) =>
            (entry.kind === "tool_call" || entry.kind === "tool_result") &&
            entry.payload.purpose === "compaction",
        ),
      ).toHaveLength(0);

      await drain(session.run({ text: "Continue after handoff", actor: MEMBER }));
      const resume = model.requests.find((request) =>
        request.context.some(
          (item) => item.type === "user_message" && item.text.includes("HISTORICAL CONTEXT"),
        ),
      );
      expect(resume).toBeDefined();
      expect(JSON.stringify(model.requests)).not.toContain("HANDOFF.md");
    } finally {
      await harness.close();
    }
  });

  test("restricted threshold compaction succeeds and answers from the injected summary", async () => {
    const { harness, session, model } = await setupRestricted({ contextWindowTokens: 300 });
    try {
      for await (const _event of session.run({
        text: "Start the long task",
        actor: MEMBER,
        skills: [],
      })) {
        // drain — long first answer pushes the next prompt over threshold
      }
      await drain(session.run({ text: "Continue the work", actor: MEMBER }));

      expect(handoffTurns(model)).toHaveLength(1);
      expect(handoffTurns(model)[0]?.tools).toEqual([]);
      const snapshot = await session.read();
      expect(
        snapshot.entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => entry.payload.status),
      ).toEqual(["started", "completed"]);
      expect(snapshot.entries.at(-1)?.kind).toBe("run_completed");
    } finally {
      await harness.close();
    }
  });

  test.each(["incomplete", "truncated"] as const)(
    "rejects a %s response even when the emitted JSON is syntactically valid",
    async (mode) => {
      const { harness, session } = await setupRestricted({ mode });
      try {
        await drain(session.run({ text: "Prepare fixture work", actor: MEMBER, skills: [] }));
        await expect(drain(session.compact(MEMBER))).rejects.toThrow(
          "Compaction summary response was incomplete",
        );
        expect(
          (await session.read()).entries.some(
            (entry) => entry.kind === "compaction" && entry.payload.status === "completed",
          ),
        ).toBe(false);
      } finally {
        await harness.close();
      }
    },
  );

  test("preserves compaction provider usage separately from task output", async () => {
    const { harness, session } = await setupRestricted();
    try {
      await drain(session.run({ text: "Prepare fixture work", actor: MEMBER, skills: [] }));
      let liveDeltas = 0;
      for await (const event of session.compact(MEMBER)) {
        if (event.type === "assistant_delta" || event.type === "reasoning_delta") liveDeltas += 1;
      }
      const metadata = (await session.read()).entries.filter(
        (entry) => entry.kind === "provider_response" && entry.payload.purpose === "compaction",
      );
      expect(metadata).toHaveLength(1);
      expect(metadata[0]?.payload.response).toEqual(SUMMARY_RESPONSE);
      expect(liveDeltas).toBe(0);
    } finally {
      await harness.close();
    }
  });

  test("prose-only compaction responses are rejected without a completed entry", async () => {
    const { harness, session } = await setupRestricted({ mode: "prose" });
    try {
      for await (const _event of session.run({ text: "Do work", actor: MEMBER, skills: [] })) {
        // drain
      }
      await expect(drain(session.compact(MEMBER))).rejects.toThrow(
        "Compaction summary was invalid",
      );
      const snapshot = await session.read();
      expect(
        snapshot.entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => entry.payload.status),
      ).toEqual(["started", "failed"]);
      expect(snapshot.entries.find((entry) => entry.kind === "run_failed")).toBeDefined();
    } finally {
      await harness.close();
    }
  });

  test("empty compaction responses are rejected without a completed entry", async () => {
    const { harness, session } = await setupRestricted({ mode: "empty" });
    try {
      for await (const _event of session.run({ text: "Do work", actor: MEMBER, skills: [] })) {
        // drain
      }
      await expect(drain(session.compact(MEMBER))).rejects.toThrow("Compaction summary was empty");
      const snapshot = await session.read();
      expect(
        snapshot.entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => entry.payload.status),
      ).toEqual(["started", "failed"]);
    } finally {
      await harness.close();
    }
  });

  test("oversized compaction responses are rejected without truncation or completion", async () => {
    expect(MAX_HANDOFF_BYTES).toBe(64 * 1024);
    const { harness, session } = await setupRestricted({ mode: "oversized" });
    try {
      for await (const _event of session.run({ text: "Do work", actor: MEMBER, skills: [] })) {
        // drain
      }
      await expect(drain(session.compact(MEMBER))).rejects.toThrow(
        "Compaction summary exceeds the size limit",
      );
      const snapshot = await session.read();
      expect(
        snapshot.entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => entry.payload.status),
      ).toEqual(["started", "failed"]);
    } finally {
      await harness.close();
    }
  });

  test("unexpected compaction tool calls are refused without execution", async () => {
    const { harness, session, projectDirectory } = await setupRestricted({
      mode: "compactionToolCall",
    });
    try {
      for await (const _event of session.run({ text: "Do work", actor: MEMBER, skills: [] })) {
        // drain
      }
      await expect(drain(session.compact(MEMBER))).rejects.toThrow(
        "Compaction response must not call tools",
      );
      await expect(
        readFile(join(projectDirectory, "should-never-exist.txt"), "utf8"),
      ).rejects.toThrow();
      const snapshot = await session.read();
      expect(snapshot.entries.filter((entry) => entry.kind === "tool_result")).toHaveLength(0);
      expect(
        snapshot.entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => entry.payload.status),
      ).toEqual(["started", "failed"]);
    } finally {
      await harness.close();
    }
  });

  test("injected durable-storage failure cannot create a false completed entry", async () => {
    const { harness, session } = await setupRestricted();
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
      if (kind === "compaction" && payload.status === "completed") {
        throw new Error("injected storage failure");
      }
      return originalAppendEntry.call(this, sessionId, kind, payload, now);
    };
    try {
      for await (const _event of session.run({ text: "Do work", actor: MEMBER, skills: [] })) {
        // drain
      }
      await expect(drain(session.compact(MEMBER))).rejects.toThrow(
        "Compaction summary could not be saved",
      );
      const snapshot = await session.read();
      expect(
        snapshot.entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => entry.payload.status),
      ).toEqual(["started", "failed"]);
      // Accepted user intent survives the failed publish.
      expect(
        snapshot.entries
          .filter((entry) => entry.kind === "user_message")
          .map((entry) => entry.payload.text),
      ).toContain("Do work");
    } finally {
      Object.defineProperty(storePrototype, "appendEntry", originalDescriptor);
      await harness.close();
    }
  });

  test("cancelling compaction records an aborted run without a completed entry", async () => {
    const { harness, session } = await setupRestricted({ mode: "hangOnHandoff" });
    try {
      for await (const _event of session.run({ text: "Do work", actor: MEMBER, skills: [] })) {
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
      expect(
        snapshot.entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => entry.payload.status),
      ).toEqual(["started"]);
    } finally {
      await harness.close();
    }
  });

  test("legacy prose handoffs resume without reading any temp folder", () => {
    const model = { connectionId: "fake", modelId: "fake-model" };
    const entries = [
      {
        id: "entry-1",
        sessionId: "session-1",
        sequence: 1,
        kind: "user_message",
        payload: { text: "Old work", model, reasoning: "none" },
        createdAt: "2026-07-10T10:00:00.000Z",
      },
      {
        id: "entry-2",
        sessionId: "session-1",
        sequence: 2,
        kind: "compaction",
        payload: {
          runId: "run-1",
          status: "completed",
          handoffDirectory: "/tmp/gone/opengui/handoffs",
          handoffPath: "/tmp/gone/opengui/handoffs/HANDOFF.md",
          handoff: "# Old prose\n\n## Next steps\n1. Keep going.\n",
          model,
          reasoning: "none",
          reason: "threshold",
        },
        createdAt: "2026-07-10T10:00:01.000Z",
      },
    ] as unknown as SessionEntry[];
    const context = buildModelContext(entries);
    expect(context).toHaveLength(1);
    const first = context[0];
    expect(first).toMatchObject({
      type: "user_message",
      text: expect.stringContaining("HISTORICAL CONTEXT"),
    });
    const firstText = first?.type === "user_message" ? first.text : "";
    expect(firstText).toContain("Keep going.");
    expect(firstText).not.toContain("/tmp/gone");
  });

  test("two concurrent sessions keep isolated handoffs", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    const homeDirectory = join(dataDirectory, "home");
    await mkdir(projectDirectory, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    const canonicalProject = await realpath(projectDirectory);
    const model = new JsonHandoffModel("sessionGoal");
    const harness = createOpenGuiHarness({
      dataDirectory,
      homeDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
      compaction: { contextWindowTokens: 10_000 },
      resolveExecutionPolicy: async () => projectScopedPolicy(canonicalProject),
    });
    try {
      const first = await harness.createSession({
        projectDirectory,
        model: { connectionId: "fake", modelId: "fake-model" },
        reasoning: "none",
      });
      const second = await harness.createSession({
        projectDirectory,
        model: { connectionId: "fake", modelId: "fake-model" },
        reasoning: "none",
      });
      for await (const _event of first.run({ text: "First work", actor: MEMBER, skills: [] })) {
        // drain
      }
      for await (const _event of second.run({ text: "Second work", actor: MEMBER, skills: [] })) {
        // drain
      }
      await Promise.all([drain(first.compact(MEMBER)), drain(second.compact(MEMBER))]);
      const firstHandoff = (await first.read()).entries.find(
        (entry) => entry.kind === "compaction" && entry.payload.status === "completed",
      )?.payload.handoff as string;
      const secondHandoff = (await second.read()).entries.find(
        (entry) => entry.kind === "compaction" && entry.payload.status === "completed",
      )?.payload.handoff as string;
      const firstId = (await first.read()).id;
      const secondId = (await second.read()).id;
      expect(firstHandoff).toContain(firstId);
      expect(firstHandoff).not.toContain(secondId);
      expect(secondHandoff).toContain(secondId);
      expect(secondHandoff).not.toContain(firstId);
    } finally {
      await harness.close();
    }
  });

  test("grant revocation blocks publishing and restart resumes from durable history", async () => {
    let revoked = false;
    const { harness, session, dataDirectory } = await setupRestricted({
      revoked: () => revoked,
    });
    try {
      for await (const _event of session.run({ text: "Do work", actor: MEMBER, skills: [] })) {
        // drain
      }
      revoked = true;
      // Authorization failure aborts the compaction run without rethrowing;
      // the denial is durable as run_failed and nothing is published.
      await drain(session.compact(MEMBER));
      const afterRevoke = await session.read();
      // Revocation hits before any compaction entry is published.
      expect(afterRevoke.entries.filter((entry) => entry.kind === "compaction")).toEqual([]);
      expect(afterRevoke.entries.at(-1)).toMatchObject({
        kind: "run_failed",
        payload: { error: expect.stringContaining("denied") },
      });
      const sessionId = (await session.read()).id;
      await harness.close();

      revoked = false;
      const reopened = createOpenGuiHarness({
        dataDirectory,
        homeDirectory: join(dataDirectory, "home"),
        model: new JsonHandoffModel(),
        clock: new FakeClock("2026-07-10T10:00:00.000Z"),
        ids: new SequenceIdGenerator(100),
        compaction: { contextWindowTokens: 10_000 },
        resolveExecutionPolicy: async () =>
          projectScopedPolicy(await realpath(join(dataDirectory, "project"))),
      });
      try {
        const same = await reopened.openSession(sessionId);
        // Compaction never completed, so this turn runs without resume context.
        for await (const _event of same.run({ text: "Retry after re-grant", actor: MEMBER })) {
          // drain
        }
        expect(
          (await same.read()).entries
            .filter((entry) => entry.kind === "user_message")
            .map((entry) => entry.payload.text),
        ).toContain("Retry after re-grant");
      } finally {
        await reopened.close();
      }
    } finally {
      await harness.close().catch(() => undefined);
    }
  });

  test("restart after a completed compaction resumes from the durable summary", async () => {
    const { harness, session, dataDirectory } = await setupRestricted();
    const sessionId = (await session.read()).id;
    try {
      for await (const _event of session.run({ text: "Do work", actor: MEMBER, skills: [] })) {
        // drain
      }
      await drain(session.compact(MEMBER));
    } finally {
      await harness.close();
    }
    const reopenedModel = new JsonHandoffModel();
    const reopened = createOpenGuiHarness({
      dataDirectory,
      homeDirectory: join(dataDirectory, "home"),
      model: reopenedModel,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(100),
      compaction: { contextWindowTokens: 10_000 },
      resolveExecutionPolicy: async () =>
        projectScopedPolicy(await realpath(join(dataDirectory, "project"))),
    });
    try {
      const same = await reopened.openSession(sessionId);
      for await (const _event of same.run({ text: "Continue after restart", actor: MEMBER })) {
        // drain
      }
      const resume = reopenedModel.requests.find((request) =>
        request.context.some(
          (item) => item.type === "user_message" && item.text.includes("HISTORICAL CONTEXT"),
        ),
      );
      expect(resume?.context[0]).toMatchObject({
        text: expect.stringContaining("Continue the fixture task."),
      });
    } finally {
      await reopened.close();
    }
  });

  test("ordinary foreign-project writes stay denied while compaction succeeds", async () => {
    const { harness, session, model, dataDirectory } = await setupRestricted({
      mode: "outsideTaskWrite",
    });
    try {
      for await (const _event of session.run({ text: "Do work", actor: MEMBER, skills: [] })) {
        // drain
      }
      const outputs = (await session.read()).entries
        .filter((entry) => entry.kind === "tool_result")
        .map((entry) => entry.payload.output);
      expect(outputs[0]).toMatchObject({ denied: true, reason: "outside_grants" });
      await expect(readFile(join(dataDirectory, "outside.txt"), "utf8")).rejects.toThrow();

      // Switch the shared fixture back to valid summaries for compaction.
      model.mode = "valid";
      await drain(session.compact(MEMBER));
      expect(
        (await session.read()).entries
          .filter((entry) => entry.kind === "compaction")
          .map((entry) => entry.payload.status),
      ).toEqual(["started", "completed"]);
    } finally {
      await harness.close();
    }
  });

  test("actor-specific live instructions apply during compact and resume", async () => {
    const { harness, session, model } = await setupRestricted({
      customInstructions: (actor) => `Instructions for ${actor?.id ?? "nobody"}`,
    });
    try {
      const alice: DurableActor = { type: "user", id: "alice", displayName: "Alice" };
      const bob: DurableActor = { type: "user", id: "bob", displayName: "Bob" };
      for await (const _event of session.run({ text: "Do work", actor: alice, skills: [] })) {
        // drain
      }
      await drain(session.compact(bob));
      const compactionTurn = handoffTurns(model)[0];
      expect(compactionTurn?.systemPrompt).toContain("Instructions for bob");
      expect(compactionTurn?.systemPrompt).not.toContain("Instructions for alice");

      await drain(session.run({ text: "Continue", actor: bob }));
      const resumeTurn = model.requests.find((request) =>
        request.context.some(
          (item) => item.type === "user_message" && item.text.includes("HISTORICAL CONTEXT"),
        ),
      );
      expect(resumeTurn?.systemPrompt).toContain("Instructions for bob");
      expect(resumeTurn?.systemPrompt).not.toContain("Instructions for alice");
    } finally {
      await harness.close();
    }
  });
});
