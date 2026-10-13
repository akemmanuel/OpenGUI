import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { DurableActor, ModelTransport, SessionEntry } from "@opengui/harness";
import { OpenGuiHost, type HostEvent } from "./opengui-host.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("OpenGuiHost compaction failure live delivery", () => {
  test("subscribers receive the failed compaction entry emitted by manual compact", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-compaction-events-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const actor: DurableActor = { type: "user", id: "owner-1", displayName: "Owner" };
    const model: ModelTransport = {
      async *stream(request) {
        const last = request.context.at(-1);
        if (last?.type === "user_message" && last.text.includes("CONTEXT HANDOFF MODE")) {
          yield { type: "text_delta", delta: "# Handoff\n\nprose, not json\n" };
        } else {
          yield { type: "text_delta", delta: "task answer" };
        }
        yield { type: "completed" };
      },
    };
    const host = new OpenGuiHost(root, { model });
    await host.start();
    try {
      await host.upsertModelConnection({
        id: "offline",
        label: "Offline",
        baseUrl: "http://offline.test/v1",
        modelIds: ["test-model"],
      });
      const created = await host.createSession(
        {
          projectDirectory: project,
          model: { connectionId: "offline", modelId: "test-model" },
          reasoning: "none",
        },
        actor,
      );
      const sessionId = created.id;
      await host.prompt(sessionId, { text: "Do some work", actor }, actor);
      await waitFor("task run to finish", () =>
        host.readSession(sessionId, actor).then((snapshot) => snapshot.status !== "running"),
      );

      const events: HostEvent[] = [];
      const unsubscribe = await host.subscribe(actor, sessionId, (event) => {
        events.push(event);
      });
      try {
        await host.compact(sessionId, actor);
        await waitFor("failed compaction live delivery", () =>
          events.some(
            (event) =>
              event.event.type === "entry_appended" &&
              event.event.entry.kind === "compaction" &&
              event.event.entry.payload.status === "failed",
          ),
        );
      } finally {
        unsubscribe();
      }

      const liveFailed = events.find(
        (event) =>
          event.event.type === "entry_appended" &&
          event.event.entry.kind === "compaction" &&
          event.event.entry.payload.status === "failed",
      );
      const durable = (await host.readSession(sessionId, actor)).entries.filter(
        (entry: SessionEntry) => entry.kind === "compaction" && entry.payload.status === "failed",
      );
      expect(durable).toHaveLength(1);
      expect(durable[0]?.payload).toMatchObject({
        failureSource: "summary",
        reason: "manual",
      });
      expect(liveFailed?.event.type === "entry_appended" ? liveFailed.event.entry.id : null).toBe(
        durable[0]?.id,
      );
    } finally {
      await host.close();
    }
  });
});
