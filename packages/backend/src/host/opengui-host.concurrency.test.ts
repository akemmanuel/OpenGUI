import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { DurableActor, ModelTransport } from "@opengui/harness";
import { OpenGuiHost, type SessionAccessGate } from "./opengui-host.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("OpenGuiHost concurrent arbitration", () => {
  test("serializes concurrent Project and model state mutations without lost restart state", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-state-concurrency-"));
    temporaryDirectories.push(root);
    const firstProject = join(root, "first");
    const secondProject = join(root, "second");
    await Promise.all([mkdir(firstProject), mkdir(secondProject)]);
    const host = new OpenGuiHost(root);
    await host.start();

    await Promise.all([
      host.registerProject(firstProject),
      host.registerProject(secondProject),
      host.upsertModelConnection({
        id: "first-model",
        label: "First",
        baseUrl: "http://first.invalid/v1",
        apiKey: "first-secret",
        modelIds: ["fixture"],
      }),
      host.upsertModelConnection({
        id: "second-model",
        label: "Second",
        baseUrl: "http://second.invalid/v1",
        apiKey: "second-secret",
        modelIds: ["fixture"],
      }),
    ]);
    await host.close();

    const restarted = new OpenGuiHost(root);
    await restarted.start();
    expect((await restarted.listProjects()).map((project) => project.directory).sort()).toEqual(
      [firstProject, secondProject].sort(),
    );
    expect(
      restarted
        .listModelConnections()
        .map((model) => model.id)
        .sort(),
    ).toEqual(["first-model", "second-model"]);
    await restarted.close();
  });
  test("two prompts arriving together accept one Run and one FIFO follow-up", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-concurrency-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const model: ModelTransport = {
      async *stream(_request, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        yield { type: "completed" };
      },
    };
    const host = new OpenGuiHost(root, { model });
    await host.start();
    await host.upsertModelConnection({
      id: "offline",
      label: "Offline",
      baseUrl: "http://offline.test/v1",
      modelIds: ["fixture-model"],
    });
    const session = await host.createSession({
      projectDirectory: project,
      model: { connectionId: "offline", modelId: "fixture-model" },
      reasoning: "none",
    });

    const results = await Promise.all([
      host.prompt(session.id, { text: "first arrival" }),
      host.prompt(session.id, { text: "second arrival" }),
    ]);

    expect(results.map((result) => result.mode).sort()).toEqual(["follow_up", "run"]);
    const snapshot = await host.readSession(session.id);
    expect(snapshot.followUps.map((followUp) => followUp.prompt.text)).toEqual(["second arrival"]);
    await host.abort(session.id);
    await host.close();
  });

  test("abort does not resolve until the running Session is stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-abort-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const model: ModelTransport = {
      async *stream(_request, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => setTimeout(() => reject(new Error("aborted")), 10),
            { once: true },
          );
        });
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

    await host.prompt(session.id, { text: "keep running" });
    await host.abort(session.id);

    const snapshot = await host.readSession(session.id);
    expect(snapshot.status).not.toBe("running");
    expect(snapshot.entries.at(-1)?.kind).toBe("run_aborted");
    await host.close();
  });

  test("never sends image bytes to the text-only DeepSeek Zen model", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-text-only-image-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const imagePath = join(project, "pixel.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const requests: Parameters<ModelTransport["stream"]>[0][] = [];
    const model: ModelTransport = {
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "tool_call", id: "read-image", name: "read", input: { path: imagePath } };
        }
        yield { type: "completed" };
      },
    };
    const host = new OpenGuiHost(root, { model });
    await host.start();
    await host.upsertModelConnection({
      id: "opencode-zen",
      label: "OpenCode Zen",
      baseUrl: "https://opencode.ai/zen/v1",
      modelIds: ["deepseek-v4-flash-free"],
    });
    const session = await host.createSession({
      projectDirectory: project,
      model: { connectionId: "opencode-zen", modelId: "deepseek-v4-flash-free" },
      reasoning: "max",
    });

    await host.prompt(session.id, { text: "read the image" });
    await host.waitForIdle(session.id);

    expect(JSON.stringify(requests[1]?.context)).not.toMatch(/iVBOR|read-image-0\.png/);
    expect(JSON.stringify(requests[1]?.context)).toContain('"attachments":[]');
    expect(JSON.stringify(requests[1]?.context)).toContain("image was omitted");
    await host.close();
  });

  test("a Run completing during admission does not reject the next concurrent prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-fast-concurrency-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const model: ModelTransport = {
      async *stream() {
        yield { type: "text_delta", delta: "done" };
        yield { type: "completed" };
      },
    };
    const host = new OpenGuiHost(root, { model });
    await host.start();
    await host.upsertModelConnection({
      id: "offline",
      label: "Offline",
      baseUrl: "http://offline.test/v1",
      modelIds: ["fixture-model"],
    });
    const session = await host.createSession({
      projectDirectory: project,
      model: { connectionId: "offline", modelId: "fixture-model" },
      reasoning: "none",
    });

    await expect(
      Promise.all([
        host.prompt(session.id, { text: "first arrival" }),
        host.prompt(session.id, { text: "second arrival" }),
      ]),
    ).resolves.toHaveLength(2);
    await host.waitForIdle(session.id);
    expect(
      (await host.readSession(session.id)).entries
        .filter((entry) => entry.kind === "user_message")
        .map((entry) => entry.payload.text),
    ).toEqual(["first arrival", "second arrival"]);
    await host.close();
  });

  test("concurrent send-now requests dispatch a durable follow-up at most once", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-send-now-race-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    let requestCount = 0;
    const model: ModelTransport = {
      async *stream(_request, signal) {
        requestCount += 1;
        if (requestCount === 1) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
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
    await host.prompt(session.id, { text: "active" });
    const queued = await host.prompt(session.id, { text: "send me once" });
    expect(queued.mode).toBe("follow_up");
    if (queued.mode !== "follow_up") throw new Error("expected a queued follow-up");

    const results = await Promise.allSettled([
      host.sendFollowUpNow(session.id, queued.followUp.id),
      host.sendFollowUpNow(session.id, queued.followUp.id),
    ]);
    await host.waitForIdle(session.id);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (await host.readSession(session.id)).entries.filter(
        (entry) => entry.kind === "user_message" && entry.payload.text === "send me once",
      ),
    ).toHaveLength(1);
    await host.close();
  });

  test("waitForIdle includes a prompt already waiting in admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-wait-admission-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const actor: DurableActor = { type: "user", id: "ada", displayName: "Ada" };
    let releaseAdmission!: () => void;
    const admissionBlocked = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let authorizationCount = 0;
    const access: SessionAccessGate = {
      async onCreated() {},
      async onDeleted() {},
      async authorize() {
        authorizationCount += 1;
        if (authorizationCount === 1) await admissionBlocked;
      },
      async filterList(sessionIds) {
        return sessionIds;
      },
    };
    const model: ModelTransport = {
      async *stream() {
        yield { type: "completed" };
      },
    };
    const host = new OpenGuiHost(root, { model, sessionAccess: access });
    await host.start();
    const session = await host.createSession(
      {
        projectDirectory: project,
        model: { connectionId: "offline", modelId: "fixture-model" },
        reasoning: "none",
      },
      actor,
    );

    const prompting = host.prompt(session.id, { text: "admitted first", actor });
    await Promise.resolve();
    let idle = false;
    const waiting = host.waitForIdle(session.id, actor).then(() => {
      idle = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(idle).toBe(false);
    releaseAdmission();
    await prompting;
    await waiting;
    expect(
      (await host.readSession(session.id, actor)).entries.filter(
        (entry) => entry.kind === "run_completed",
      ),
    ).toHaveLength(1);
    await host.close();
  });
});
