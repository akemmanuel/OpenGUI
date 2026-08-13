import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { DurableActor, ModelTransport } from "@opengui/harness";
import { HARNESS_DATABASE_FILENAME } from "@opengui/harness";
import { createOpenGuiHarness } from "@opengui/harness";
import { HOST_STATE_FILENAME, OpenGuiHost, type SessionAccessGate } from "./opengui-host.ts";

const temporaryDirectories: string[] = [];

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolveReached) => {
    release = resolveReached;
  });
  return { reached, release };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("OpenGuiHost lifecycle", () => {
  test("compensates a Session when owner metadata creation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-acl-create-failure-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const actor: DurableActor = { type: "user", id: "ada", displayName: "Ada" };
    const access: SessionAccessGate = {
      async onCreated() {
        throw new Error("ACL unavailable");
      },
      async onDeleted() {},
      async authorize() {},
      async filterList(ids) {
        return ids;
      },
    };
    const host = new OpenGuiHost(root, { sessionAccess: access });
    await host.start();

    await expect(
      host.createSession(
        {
          projectDirectory: project,
          model: { connectionId: "offline", modelId: "fixture" },
          reasoning: "none",
        },
        actor,
      ),
    ).rejects.toThrow("ACL unavailable");
    await expect(host.listSessions(project, actor)).resolves.toEqual([]);
    await host.close();
  });

  test("rejects reasoning efforts unsupported by the selected model connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-reasoning-effort-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const host = new OpenGuiHost(root);
    await host.start();
    await host.upsertModelConnection({
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      modelIds: ["deepseek-v4-pro"],
      modelCapabilities: {
        "deepseek-v4-pro": { reasoning: true, reasoningEfforts: ["none", "high", "max"] },
      },
    });
    await expect(
      host.createSession({
        projectDirectory: project,
        model: { connectionId: "deepseek", modelId: "deepseek-v4-pro" },
        reasoning: "ultra",
      }),
    ).rejects.toThrow("does not support reasoning effort ultra");
    const session = await host.createSession({
      projectDirectory: project,
      model: { connectionId: "deepseek", modelId: "deepseek-v4-pro" },
      reasoning: "high",
    });

    await expect(host.setReasoning(session.id, "ultra")).rejects.toThrow(
      "does not support reasoning effort ultra",
    );
    await expect(host.setReasoning(session.id, "max")).resolves.toMatchObject({
      reasoning: "max",
    });
    await host.close();
  });

  test("hides crash-created orphan Sessions without deleting their durable transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-acl-restart-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const harness = createOpenGuiHarness({
      dataDirectory: root,
      model: {
        async *stream() {
          yield { type: "completed" as const };
        },
      },
    });
    const orphan = await harness.createSession({
      projectDirectory: project,
      model: { connectionId: "offline", modelId: "fixture" },
      reasoning: "none",
    });
    const orphanId = (await orphan.read()).id;
    await harness.close();
    const metadata = new Set(["stale-session"]);
    const access: SessionAccessGate = {
      async onCreated(id) {
        metadata.add(id);
      },
      async onDeleted(id) {
        metadata.delete(id);
      },
      async authorize(id) {
        if (!metadata.has(id)) throw new Error("Session not found");
      },
      async filterList(ids) {
        return ids.filter((id) => metadata.has(id));
      },
      async reconcile(ids) {
        for (const id of metadata) if (!ids.includes(id)) metadata.delete(id);
        return ids.filter((id) => metadata.has(id));
      },
    };
    const host = new OpenGuiHost(root, { sessionAccess: access });

    await host.start();

    expect(metadata).toEqual(new Set());
    await expect(host.readSessionForViewLink(orphanId)).resolves.toMatchObject({ id: orphanId });
    await host.close();
  });

  test("reconciles stale ACL metadata after a deletion hook failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-acl-delete-failure-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const actor: DurableActor = { type: "user", id: "ada", displayName: "Ada" };
    const metadata = new Set<string>();
    let failDelete = true;
    const access: SessionAccessGate = {
      async onCreated(id) {
        metadata.add(id);
      },
      async onDeleted(id) {
        if (failDelete) throw new Error("ACL delete unavailable");
        metadata.delete(id);
      },
      async authorize(id) {
        if (!metadata.has(id)) throw new Error("Session not found");
      },
      async filterList(ids) {
        return ids.filter((id) => metadata.has(id));
      },
      async reconcile(ids) {
        for (const id of metadata) if (!ids.includes(id)) metadata.delete(id);
        return ids.filter((id) => metadata.has(id));
      },
    };
    const host = new OpenGuiHost(root, { sessionAccess: access });
    await host.start();
    const session = await host.createSession(
      {
        projectDirectory: project,
        model: { connectionId: "offline", modelId: "fixture" },
        reasoning: "none",
      },
      actor,
    );

    await expect(host.deleteSession(session.id, actor)).rejects.toThrow("ACL delete unavailable");
    expect(metadata).toEqual(new Set([session.id]));
    await host.close();
    failDelete = false;
    await host.start();
    expect(metadata).toEqual(new Set());
    await host.close();
  });

  test("fails explicitly when another Host owns the same durable state", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-state-lock-"));
    temporaryDirectories.push(root);
    const first = new OpenGuiHost(root);
    const second = new OpenGuiHost(root);
    await first.start();

    await expect(second.start()).rejects.toThrow("already in use");
    await first.close();
    await expect(second.start()).resolves.toBeUndefined();
    await second.close();
  });
  test("a close racing initial startup waits for startup and leaves the Host closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-start-close-race-"));
    temporaryDirectories.push(root);
    const host = new OpenGuiHost(root);

    const starting = host.start();
    const closing = host.close();
    await Promise.all([starting, closing]);

    await expect(host.listSessions(root)).rejects.toThrow("not started");
  });

  test("rejects a second startup while the first startup is in progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-double-start-"));
    temporaryDirectories.push(root);
    const host = new OpenGuiHost(root);

    const results = await Promise.allSettled([host.start(), host.start()]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    await host.close();
  });

  test("a Host can retry startup after asynchronous storage recovery fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-start-retry-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, HARNESS_DATABASE_FILENAME);
    await writeFile(databasePath, "not a sqlite database");
    const host = new OpenGuiHost(root);

    await expect(host.start()).rejects.toThrow();
    await rm(databasePath, { force: true });

    await expect(host.start()).resolves.toBeUndefined();
    await host.close();
  });

  test("a failed Project settings write does not publish non-durable state", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-settings-failure-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const settingsPath = join(root, HOST_STATE_FILENAME);
    const host = new OpenGuiHost(root);
    await host.start();
    await mkdir(settingsPath);

    await expect(host.registerProject(project)).rejects.toThrow();
    await rm(settingsPath, { recursive: true });

    await expect(host.listProjects()).resolves.toEqual([]);
    await host.close();
  });

  test("a failed Project removal remains visible and restartable", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-project-removal-failure-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const settingsPath = join(root, HOST_STATE_FILENAME);
    const host = new OpenGuiHost(root);
    await host.start();
    await host.registerProject(project);
    await rm(settingsPath);
    await mkdir(settingsPath);

    await expect(host.unregisterProject(project)).rejects.toThrow();
    await rm(settingsPath, { recursive: true });

    await expect(host.listProjects()).resolves.toEqual([{ directory: project, name: "project" }]);
    await host.close();
  });

  test("a failed Model connection write does not change the live transport catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-model-write-failure-"));
    temporaryDirectories.push(root);
    const settingsPath = join(root, HOST_STATE_FILENAME);
    const host = new OpenGuiHost(root);
    await host.start();
    await mkdir(settingsPath);

    await expect(
      host.upsertModelConnection({
        id: "failed-model",
        label: "Failed model",
        baseUrl: "https://model.invalid/v1",
        apiKey: "must-not-publish",
        modelIds: ["fixture"],
      }),
    ).rejects.toThrow();
    await rm(settingsPath, { recursive: true });

    expect(host.listModelConnections()).toEqual([]);
    await host.close();
  });

  test("a failed Model connection removal preserves the usable connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-model-remove-failure-"));
    temporaryDirectories.push(root);
    const settingsPath = join(root, HOST_STATE_FILENAME);
    const host = new OpenGuiHost(root);
    await host.start();
    await host.upsertModelConnection({
      id: "keep-model",
      label: "Keep model",
      baseUrl: "https://model.invalid/v1",
      apiKey: "keep-secret",
      modelIds: ["fixture"],
    });
    await rm(settingsPath);
    await mkdir(settingsPath);

    await expect(host.removeModelConnection("keep-model")).rejects.toThrow();
    await rm(settingsPath, { recursive: true });

    expect(host.listModelConnections().map((connection) => connection.id)).toEqual(["keep-model"]);
    await host.close();
  });

  test("a secrets write failure rolls back the companion settings write for restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-secrets-write-failure-"));
    temporaryDirectories.push(root);
    const secretsPath = join(root, HOST_STATE_FILENAME);
    const host = new OpenGuiHost(root);
    await host.start();
    await mkdir(secretsPath);

    await expect(
      host.upsertModelConnection({
        id: "partial-model",
        label: "Partial model",
        baseUrl: "https://model.invalid/v1",
        apiKey: "partial-secret",
        modelIds: ["fixture"],
      }),
    ).rejects.toThrow();
    await rm(secretsPath, { recursive: true });
    await host.close();

    const restarted = new OpenGuiHost(root);
    await restarted.start();
    expect(restarted.listModelConnections()).toEqual([]);
    await restarted.close();
  });

  test("start may be closed immediately and the same data directory may be reopened", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-lifecycle-"));
    temporaryDirectories.push(root);
    const first = new OpenGuiHost(root);
    await first.start();
    await first.close();

    const restarted = new OpenGuiHost(root);
    await restarted.start();
    await expect(restarted.listSessions(root)).resolves.toEqual([]);
    await restarted.close();
  });

  test("repeated concurrent close calls share shutdown and leave restart state usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-repeated-close-"));
    temporaryDirectories.push(root);
    const host = new OpenGuiHost(root);
    await host.start();

    await Promise.all([host.close(), host.close(), host.close()]);
    await host.close();
    await host.start();

    await expect(host.listSessions(root)).resolves.toEqual([]);
    await host.close();
  });

  test("close aborts and drains an active model request before closing storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-active-close-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    let aborted = false;
    const model: ModelTransport = {
      async *stream(_request, signal) {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            aborted = true;
            reject(new Error("model request aborted"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("model request aborted"));
            },
            { once: true },
          );
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
    await host.prompt(session.id, { text: "long-running work" });

    await host.close();

    expect(aborted).toBe(true);
    const restarted = new OpenGuiHost(root);
    await restarted.start();
    expect((await restarted.readSession(session.id)).entries.at(-1)?.kind).toBe("run_aborted");
    await restarted.close();
  });

  test("an operation admitted before close cannot resume against a restarted Harness", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-close-epoch-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const actor: DurableActor = { type: "user", id: "ada", displayName: "Ada" };
    const authorization = barrier();
    let blockAuthorization = false;
    const access: SessionAccessGate = {
      async onCreated() {},
      async onDeleted() {},
      async authorize() {
        if (blockAuthorization) await authorization.reached;
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
    blockAuthorization = true;

    const prompting = host.prompt(session.id, { text: "must not cross close", actor });
    await Promise.resolve();
    await host.close();
    await host.start();
    authorization.release();

    await expect(prompting).rejects.toThrow("Session not found");
    expect(
      (await host.readSessionForViewLink(session.id)).entries.filter(
        (entry) => entry.kind === "user_message",
      ),
    ).toEqual([]);
    await host.close();
  });
});
