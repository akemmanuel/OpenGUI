import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { findFilesInDirectory } from "../../../server/services/file-search.ts";

async function withTempDir<T>(callback: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "opengui-file-search-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("findFilesInDirectory", () => {
  test("returns matching directories as selectable slash-terminated results", async () => {
    await withTempDir(async (directory) => {
      await mkdir(join(directory, "260602"), { recursive: true });
      await writeFile(join(directory, "260602", "example.png"), "");

      await expect(findFilesInDirectory(directory, "260602")).resolves.toEqual([
        "260602/",
        "260602/example.png",
      ]);
    });
  });
});
