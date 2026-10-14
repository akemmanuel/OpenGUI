import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vite-plus/test";

/**
 * Returns a factory for temporary directories that are removed after the
 * calling test file finishes. Call it at the top level of a test file.
 */
export function useTemporaryDirectories(prefix: string) {
  const directories: string[] = [];
  afterAll(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
  return async () => {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };
}
