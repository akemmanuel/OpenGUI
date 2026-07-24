import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createSettingsStore, SETTINGS_FILE_NAME } from "./settings-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "opengui-settings-"));
  directories.push(path);
  return path;
}

describe("Desktop settings store", () => {
  test("rejects invalid public mutations without creating a settings file", async () => {
    const root = await directory();
    const settings = createSettingsStore(root);
    expect(settings.set(null as never, "value")).toBe(false);
    expect(settings.set("", "value")).toBe(false);
    expect(settings.set("x".repeat(257), "value")).toBe(false);
    expect(settings.set("key", null as never)).toBe(false);
    expect(settings.set("key", "x".repeat(1_000_001))).toBe(false);
    expect(settings.remove(null as never)).toBe(false);
    expect(settings.merge(null)).toBe(false);
    expect(settings.merge([])).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  test("persists set, merge, and remove behavior across Shell restarts", async () => {
    const root = await directory();
    const settings = createSettingsStore(root);

    expect(settings.set("theme", "dark")).toBe(true);
    expect(settings.merge({ locale: "de", ignored: 42 })).toBe(true);
    expect(settings.remove("theme")).toBe(true);

    const restarted = createSettingsStore(root);
    expect(restarted.getAll()).toEqual({ locale: "de" });
    expect(JSON.parse(await readFile(join(root, SETTINGS_FILE_NAME), "utf8"))).toEqual({
      version: 1,
      values: { locale: "de" },
    });
  });

  test("recovers safely from malformed or legacy settings files", async () => {
    const root = await directory();
    const file = join(root, SETTINGS_FILE_NAME);
    await writeFile(file, "not-json", "utf8");
    expect(createSettingsStore(root).getAll()).toEqual({});

    await writeFile(file, JSON.stringify({ theme: "light", unsafe: false }), "utf8");
    expect(createSettingsStore(root).getAll()).toEqual({ theme: "light" });
  });

  test.each([
    ["null"],
    ["[]"],
    [JSON.stringify({ version: 1, values: ["not", "a", "map"] })],
    [JSON.stringify({ version: 1, values: { valid: "yes", ignored: 42 } })],
  ])("normalizes corrupt payload %s without exposing invalid values", async (payload) => {
    const root = await directory();
    await writeFile(join(root, SETTINGS_FILE_NAME), payload, "utf8");
    const expected = payload.includes('"valid"') ? { valid: "yes" } : {};
    expect(createSettingsStore(root).getAll()).toEqual(expected);
  });

  test("keeps both disk and in-memory state unchanged when atomic replacement fails", async () => {
    const root = await directory();
    const initial = createSettingsStore(root);
    initial.set("theme", "dark");
    const filePath = join(root, SETTINGS_FILE_NAME);
    const original = await readFile(filePath, "utf8");
    const renameSync = vi.fn(() => {
      throw new Error("disk unavailable");
    });
    const settings = createSettingsStore(root, { ...fs, renameSync });

    expect(() => settings.set("theme", "light")).toThrow("disk unavailable");
    expect(settings.get("theme")).toBe("dark");
    expect(await readFile(filePath, "utf8")).toBe(original);
    expect((await readdir(root)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test.each(["writeFileSync", "fsyncSync", "renameSync"] as const)(
    "keeps restart and live state unchanged when %s fails before replacement",
    async (operation) => {
      const root = await directory();
      createSettingsStore(root).set("theme", "dark");
      let failed = false;
      const fileSystem = {
        ...fs,
        [operation](...args: never[]) {
          if (!failed) {
            failed = true;
            throw new Error(`${operation} failed`);
          }
          return (fs[operation] as (...values: never[]) => unknown)(...args);
        },
      };
      const settings = createSettingsStore(root, fileSystem as never);

      expect(() => settings.set("theme", "light")).toThrow(`${operation} failed`);
      expect(settings.get("theme")).toBe("dark");
      expect(createSettingsStore(root).get("theme")).toBe("dark");
    },
  );

  test("keeps live state aligned with the replaced file when directory fsync fails", async () => {
    const root = await directory();
    createSettingsStore(root).set("theme", "dark");
    let syncCount = 0;
    const settings = createSettingsStore(root, {
      ...fs,
      fsyncSync(fd) {
        syncCount += 1;
        if (syncCount === 2) throw new Error("directory fsync failed");
        return fs.fsyncSync(fd);
      },
    });

    expect(() => settings.set("theme", "light")).toThrow("durability could not be confirmed");
    expect(settings.get("theme")).toBe("light");
    expect(createSettingsStore(root).get("theme")).toBe("light");
  });

  test("uses distinct temporary files for rapid atomic writes", async () => {
    const root = await directory();
    const temporaryPaths: string[] = [];
    const fileSystem = {
      ...fs,
      writeFileSync(path: fs.PathOrFileDescriptor, data: string, options: BufferEncoding) {
        temporaryPaths.push(String(path));
        fs.writeFileSync(path, data, options);
      },
    };
    const settings = createSettingsStore(root, fileSystem as never);
    settings.set("one", "1");
    settings.set("two", "2");

    expect(new Set(temporaryPaths).size).toBe(2);
    expect(createSettingsStore(root).getAll()).toEqual({ one: "1", two: "2" });
  });
});
