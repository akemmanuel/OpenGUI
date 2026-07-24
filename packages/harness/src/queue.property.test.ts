import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createOpenGuiHarness } from "./index.ts";
import type { ModelTransport } from "./models/transport.ts";
import { FakeClock, FakeModel, SequenceIdGenerator } from "./test/index.ts";
import { seeded } from "./test/seeded.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true }))));

describe("seeded Follow-up reorder properties", () => {
  test("300 arbitrary moves preserve identity, contiguous order, and persistence", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-queue-property-"));
    cleanup.push(dataDirectory);
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => (started = resolve));
    const model: ModelTransport = {
      async *stream(_request, signal) {
        started();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
        yield { type: "completed" };
      },
    };
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock: new FakeClock("2026-01-01T00:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fixture", modelId: "fixture" },
      reasoning: "none",
    });
    const run = session.run({ text: "keep running" })[Symbol.asyncIterator]();
    const draining = (async () => {
      while (!(await run.next()).done) {
        // Keep the Run alive while queue behavior is exercised.
      }
    })().catch(() => undefined);
    await modelStarted;
    const expected = [];
    for (let index = 0; index < 12; index += 1) {
      expected.push((await session.followUp({ text: `prompt-${index}` })).id);
    }
    const original = [...expected].sort();
    const random = seeded(0x51554555);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const from = random.int(0, expected.length - 1);
      const requested = random.int(-50, 50);
      const to = Math.max(0, Math.min(requested, expected.length - 1));
      const [moved] = expected.splice(from, 1);
      expected.splice(to, 0, moved!);
      await session.reorderFollowUp(moved!, requested);
      const actual = (await session.read()).followUps.map((item) => item.id);
      expect(actual, `iteration ${iteration}`).toEqual(expected);
      expect([...actual].sort()).toEqual(original);
    }
    const id = (await session.read()).id;
    await session.abort();
    await draining;
    await harness.close();

    const reopened = createOpenGuiHarness({ dataDirectory, model: new FakeModel([]) });
    expect(
      (await (await reopened.openSession(id)).read()).followUps.map((item) => item.id),
    ).toEqual(expected);
    await reopened.close();
  });
});
