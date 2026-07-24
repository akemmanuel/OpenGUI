import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  createOpenGuiHarness,
  type DurableActor,
  type ExecutionPolicy,
  type ExecutionPolicyResolver,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelTransport,
  type SessionEntry,
} from "./index.ts";
import { FakeClock, FakeModel, SequenceIdGenerator } from "./test/index.ts";

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "opengui-harness-policy-"));
}

function containsPath(root: string, candidate: string) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

function restrictedPolicy(input: {
  root: string;
  revision?: number;
  writeAllowed?: () => boolean;
  afterAuthorizedWrite?: () => void;
}): ExecutionPolicy {
  return {
    restricted: true,
    revision: input.revision ?? 1,
    shellAllowed: false,
    async authorizePath(path, access, options = {}) {
      const target = resolve(path);
      if (!containsPath(input.root, target)) return { allowed: false, reason: "outside_grants" };
      if (access === "write" && input.writeAllowed && !input.writeAllowed()) {
        return { allowed: false, reason: "read_only" };
      }
      const parts = relative(input.root, target).split(sep).filter(Boolean);
      let current = input.root;
      for (const part of parts) {
        current = join(current, part);
        try {
          if ((await lstat(current)).isSymbolicLink()) {
            return { allowed: false, reason: "symlink_traversal" };
          }
        } catch (error) {
          const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
          if (!missing || access !== "write" || !options.allowMissingLeaf) {
            return { allowed: false, reason: "not_found" };
          }
          break;
        }
      }
      // Root checks are capability advertisement; callbacks model a
      // per-path authorization changing grants after an actual tool target.
      if (access === "write" && target !== input.root) input.afterAuthorizedWrite?.();
      return { allowed: true, canonicalPath: target };
    },
  };
}

function toolOutputs(entries: SessionEntry[]) {
  return new Map(
    entries
      .filter((entry) => entry.kind === "tool_result")
      .map((entry) => [entry.payload.toolCallId, entry.payload.output]),
  );
}

describe("Harness execution policy", () => {
  test("denies outside, sibling-prefix, symlink, read-only write, and direct shell attempts", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    const siblingDirectory = join(dataDirectory, "project-private");
    await mkdir(projectDirectory);
    await mkdir(siblingDirectory);
    await writeFile(join(projectDirectory, "inside.txt"), "inside");
    await writeFile(join(siblingDirectory, "secret.txt"), "secret");
    await symlink(join(siblingDirectory, "secret.txt"), join(projectDirectory, "escape.txt"));
    const canonicalProject = await realpath(projectDirectory);
    const actor: DurableActor = { type: "user", id: "member-1", displayName: "Member" };
    const model = new FakeModel([
      {
        toolCalls: [
          { id: "outside", name: "read", input: { path: join(dataDirectory, "outside.txt") } },
          { id: "sibling", name: "read", input: { path: join(siblingDirectory, "secret.txt") } },
          { id: "symlink", name: "read", input: { path: "escape.txt" } },
          { id: "write", name: "write", input: { path: "new.txt", content: "no" } },
          { id: "shell", name: "shell", input: { command: "echo bypass" } },
        ],
      },
      { text: "Done" },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      resolveExecutionPolicy: async () =>
        restrictedPolicy({ root: canonicalProject, writeAllowed: () => false }),
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });

    for await (const _event of session.run({ text: "Try every bypass", actor })) {
      // Drain the Run.
    }

    const outputs = toolOutputs((await session.read()).entries);
    expect(outputs.get("outside")).toMatchObject({ denied: true, reason: "outside_grants" });
    expect(outputs.get("sibling")).toMatchObject({ denied: true, reason: "outside_grants" });
    expect(outputs.get("symlink")).toMatchObject({ denied: true, reason: "symlink_traversal" });
    expect(outputs.get("write")).toMatchObject({ denied: true, reason: "read_only" });
    expect(outputs.get("shell")).toEqual({
      denied: true,
      error: "Execution policy denied shell",
      policyRevision: 1,
      reason: "shell_not_allowed",
    });
    await expect(readFile(join(projectDirectory, "new.txt"), "utf8")).rejects.toThrow();
    await harness.close();
  });

  test("omits write, edit, shell, and global skills for read-only restricted model turns", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    const homeDirectory = join(dataDirectory, "home");
    await mkdir(join(projectDirectory, ".agents", "skills", "project-skill"), { recursive: true });
    await mkdir(join(homeDirectory, ".agents", "skills", "home-skill"), { recursive: true });
    await writeFile(
      join(projectDirectory, ".agents", "skills", "project-skill", "SKILL.md"),
      "---\nname: project-skill\ndescription: Project-local guidance for testing.\n---\n",
    );
    await writeFile(
      join(homeDirectory, ".agents", "skills", "home-skill", "SKILL.md"),
      "---\nname: home-skill\ndescription: Global guidance that must stay hidden.\n---\n",
    );
    const model = new FakeModel([{ text: "Done" }]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      homeDirectory,
      model,
      resolveExecutionPolicy: async () =>
        restrictedPolicy({ root: await realpath(projectDirectory), writeAllowed: () => false }),
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    for await (const _event of session.run({
      text: "Inspect",
      actor: { type: "user", id: "member-1", displayName: "Member" },
    })) {
      // Drain the Run.
    }

    expect(model.requests[0]?.tools).toEqual(["read"]);
    expect(model.requests[0]?.systemPrompt).not.toMatch(/\bshell\b/iu);
    expect(model.requests[0]?.systemPrompt).not.toMatch(/\b(?:write|edit)\b/iu);
    expect(model.requests[0]?.systemPrompt).toContain("project-skill");
    expect(model.requests[0]?.systemPrompt).not.toContain("home-skill");
    await harness.close();
  });

  test("aborts provider streaming and persists no model output after actor revocation", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(projectDirectory);
    const root = await realpath(projectDirectory);
    let revoked = false;
    let providerObservedAbort = false;
    let providerContinuedAfterRevocation = false;
    const requests: ModelRequest[] = [];
    const model: ModelTransport = {
      async *stream(request, signal): AsyncIterable<ModelStreamEvent> {
        requests.push(request);
        try {
          yield { type: "text_delta", delta: "visible live only" };
          revoked = true;
          yield { type: "text_delta", delta: "must be blocked" };
          providerContinuedAfterRevocation = true;
          yield { type: "completed" };
        } finally {
          providerObservedAbort = signal.aborted;
        }
      },
    };
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      resolveExecutionPolicy: async () => {
        if (revoked) throw new Error("Actor is revoked");
        return restrictedPolicy({ root });
      },
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    const deltas: string[] = [];

    for await (const event of session.run({
      text: "Start streaming",
      actor: { type: "api_key", id: "revoked-key", displayName: "Revoked key" },
    })) {
      if (event.type === "assistant_delta") deltas.push(event.delta);
    }

    const entries = (await session.read()).entries;
    expect(requests).toHaveLength(1);
    expect(deltas).toEqual(["visible live only"]);
    expect(providerObservedAbort).toBe(true);
    expect(providerContinuedAfterRevocation).toBe(false);
    expect(
      entries.filter((entry) =>
        ["assistant_reasoning", "assistant_message", "tool_call", "tool_result"].includes(
          entry.kind,
        ),
      ),
    ).toEqual([]);
    expect(entries.at(-1)).toMatchObject({
      kind: "run_failed",
      payload: { error: "Actor is revoked" },
    });
    await harness.close();
  });

  test("re-resolves before each tool call so a grant removal denies the next call", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(projectDirectory);
    const root = await realpath(projectDirectory);
    let writeAllowed = true;
    const resolver: ExecutionPolicyResolver = async () =>
      restrictedPolicy({
        root,
        revision: writeAllowed ? 1 : 2,
        writeAllowed: () => writeAllowed,
        afterAuthorizedWrite: () => {
          writeAllowed = false;
        },
      });
    const model = new FakeModel([
      {
        toolCalls: [
          { id: "first", name: "write", input: { path: "first.txt", content: "yes" } },
          { id: "second", name: "write", input: { path: "second.txt", content: "no" } },
        ],
      },
      { text: "Done" },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      resolveExecutionPolicy: resolver,
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    for await (const _event of session.run({
      text: "Write twice",
      actor: { type: "api_key", id: "key-1", displayName: "CI" },
    })) {
      // Drain the Run.
    }

    expect(await readFile(join(projectDirectory, "first.txt"), "utf8")).toBe("yes");
    await expect(readFile(join(projectDirectory, "second.txt"), "utf8")).rejects.toThrow();
    expect(toolOutputs((await session.read()).entries).get("second")).toMatchObject({
      denied: true,
      policyRevision: 2,
      reason: "read_only",
    });
    await harness.close();
  });

  test("retains a queued actor and reauthorizes it when the follow-up starts", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(projectDirectory);
    const root = await realpath(projectDirectory);
    const resolvedActors: Array<DurableActor | undefined> = [];
    let queuedActorAllowed = true;
    const model = new FakeModel([
      { text: "First complete" },
      {
        toolCalls: [
          { id: "queued-write", name: "write", input: { path: "queued.txt", content: "no" } },
        ],
      },
      { text: "Queue complete" },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      resolveExecutionPolicy: async (actor) => {
        resolvedActors.push(actor);
        return restrictedPolicy({
          root,
          revision: queuedActorAllowed ? 1 : 2,
          writeAllowed: () => actor?.id !== "queued" || queuedActorAllowed,
        });
      },
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    const iterator = session
      .run({ text: "First", actor: { type: "user", id: "first", displayName: "First" } })
      [Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await session.followUp({
      text: "Queued",
      actor: { type: "user", id: "queued", displayName: "Queued" },
    });
    queuedActorAllowed = false;
    while (!(await iterator.next()).done) {
      // Drain both Runs.
    }

    expect(resolvedActors.some((actor) => actor?.id === "queued")).toBe(true);
    expect(toolOutputs((await session.read()).entries).get("queued-write")).toMatchObject({
      denied: true,
      policyRevision: 2,
    });
    await harness.close();
  });

  test("retains queued actors across restart before resolving their policy", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(projectDirectory);
    const firstHarness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([{ text: "unused" }]),
      ids: new SequenceIdGenerator(),
    });
    const session = await firstHarness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    const iterator = session.run({ text: "First" })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await session.followUp({
      text: "Persisted",
      actor: { type: "api_key", id: "persisted-key", displayName: "Persisted key" },
    });
    await session.abort();
    while (!(await iterator.next()).done) {
      // Drain the aborted Run.
    }
    const sessionId = (await session.read()).id;
    await firstHarness.close();

    const resolvedActors: Array<DurableActor | undefined> = [];
    const reopenedHarness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([{ text: "Starter complete" }, { text: "Persisted complete" }]),
      ids: new SequenceIdGenerator(100),
      resolveExecutionPolicy: async (actor) => {
        resolvedActors.push(actor);
        return restrictedPolicy({ root: projectDirectory });
      },
    });
    const reopened = await reopenedHarness.openSession(sessionId);
    for await (const _event of reopened.run({
      text: "Restart",
      actor: { type: "local", id: "starter", displayName: "Starter" },
    })) {
      // Drain the starter and recovered follow-up Runs.
    }
    expect(resolvedActors.some((actor) => actor?.id === "persisted-key")).toBe(true);
    expect((await reopened.read()).entries).toContainEqual(
      expect.objectContaining({
        kind: "user_message",
        payload: expect.objectContaining({
          text: "Persisted",
          actor: { type: "api_key", id: "persisted-key", displayName: "Persisted key" },
        }),
      }),
    );
    await reopenedHarness.close();
  });

  test("keeps legacy actorless behavior unrestricted only when no resolver is configured", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(projectDirectory);
    const outsidePath = join(dataDirectory, "owner-compatible.txt");
    const model = new FakeModel([
      { toolCalls: [{ id: "write", name: "write", input: { path: outsidePath, content: "ok" } }] },
      { text: "Done" },
    ]);
    const harness = createOpenGuiHarness({ dataDirectory, model });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    for await (const _event of session.run({ text: "Legacy owner run" })) {
      // Drain the Run.
    }
    expect(await readFile(outsidePath, "utf8")).toBe("ok");
    expect(model.requests[0]?.tools).toContain("shell");
    await harness.close();

    const actorlessActors: Array<DurableActor | undefined> = [];
    const deniedHarness = createOpenGuiHarness({
      dataDirectory: await temporaryDirectory(),
      model: new FakeModel([{ text: "Done" }]),
      resolveExecutionPolicy: async (actor) => {
        actorlessActors.push(actor);
        return restrictedPolicy({ root: projectDirectory, writeAllowed: () => false });
      },
    });
    const deniedSession = await deniedHarness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    for await (const _event of deniedSession.run({ text: "Legacy delegated run" })) {
      // Drain the Run.
    }
    expect(actorlessActors).toContain(undefined);
    await deniedHarness.close();
  });
});
