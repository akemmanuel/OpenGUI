import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  openDurableJsonTransaction,
  type DurableJsonFileSystem,
} from "./durable-json-transaction.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), "opengui-durable-json-"));
  roots.push(value);
  return value;
}

describe("durable JSON transaction", () => {
  test("atomically publishes one fsynced generation and cleans its unique temporary file", async () => {
    const directory = await root();
    const transaction = await openDurableJsonTransaction(join(directory, "state.json"), {
      fallback: { value: "old" },
      validate: (value) => value as { value: string },
    });

    await transaction.replace({ value: "new" });

    expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8"))).toEqual({
      value: "new",
    });
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    await transaction.close();
  });

  test.each(["write", "fileSync", "rename"] as const)(
    "a %s failure leaves live and restart state on the previous generation",
    async (operation) => {
      const directory = await root();
      const path = join(directory, "state.json");
      const initial = await openDurableJsonTransaction(path, {
        fallback: { value: "old" },
        validate: (value) => value as { value: string },
      });
      await initial.replace({ value: "old" });
      await initial.close();
      let injected = false;
      const fileSystem: Partial<DurableJsonFileSystem> = {
        [operation]: vi.fn(async (...args: never[]) => {
          if (!injected) {
            injected = true;
            throw new Error(`${operation} failed`);
          }
          const implementation = (await import("./durable-json-transaction.ts"))
            .durableJsonFileSystem[operation] as (...values: never[]) => Promise<void>;
          return await implementation(...args);
        }),
      };
      const transaction = await openDurableJsonTransaction(path, {
        fallback: { value: "fallback" },
        validate: (value) => value as { value: string },
        fileSystem,
      });

      await expect(transaction.replace({ value: "new" })).rejects.toThrow(`${operation} failed`);
      expect(transaction.current()).toEqual({ value: "old" });
      await transaction.close();
      const restarted = await openDurableJsonTransaction(path, {
        fallback: { value: "fallback" },
        validate: (value) => value as { value: string },
      });
      expect(restarted.current()).toEqual({ value: "old" });
      await restarted.close();
    },
  );

  test("a directory fsync failure reports uncertainty but keeps live state equal to restart state", async () => {
    const directory = await root();
    const path = join(directory, "state.json");
    let failDirectorySync = false;
    const transaction = await openDurableJsonTransaction(path, {
      fallback: { value: "old" },
      validate: (value) => value as { value: string },
      fileSystem: {
        directorySync: async (...args) => {
          if (failDirectorySync) throw new Error("directory sync failed");
          return await (
            await import("./durable-json-transaction.ts")
          ).durableJsonFileSystem.directorySync(...args);
        },
      },
    });
    await transaction.replace({ value: "old" });
    failDirectorySync = true;

    await expect(transaction.replace({ value: "new" })).rejects.toMatchObject({ committed: true });
    expect(transaction.current()).toEqual({ value: "new" });
    await transaction.close();
    const restarted = await openDurableJsonTransaction(path, {
      fallback: { value: "fallback" },
      validate: (value) => value as { value: string },
    });
    expect(restarted.current()).toEqual({ value: "new" });
    await restarted.close();
  });

  test("serializes concurrent writers at deterministic barriers without lost updates", async () => {
    const directory = await root();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    let writes = 0;
    const transaction = await openDurableJsonTransaction(join(directory, "state.json"), {
      fallback: { values: [] as string[] },
      validate: (value) => value as { values: string[] },
      fileSystem: {
        async write(...args) {
          writes += 1;
          if (writes === 1) await barrier;
          return await (
            await import("./durable-json-transaction.ts")
          ).durableJsonFileSystem.write(...args);
        },
      },
    });

    const first = transaction.update((state) => ({ values: [...state.values, "first"] }));
    const second = transaction.update((state) => ({ values: [...state.values, "second"] }));
    release();
    await Promise.all([first, second]);

    expect(transaction.current()).toEqual({ values: ["first", "second"] });
    await transaction.close();
  });

  test("fails explicitly while another process owner holds the state lock", async () => {
    const directory = await root();
    const path = join(directory, "state.json");
    const first = await openDurableJsonTransaction(path, {
      fallback: {},
      validate: (value) => value as object,
    });
    await expect(
      openDurableJsonTransaction(path, {
        fallback: {},
        validate: (value) => value as object,
      }),
    ).rejects.toThrow("already in use");
    await first.close();
  });
});
