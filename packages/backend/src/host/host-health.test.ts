import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { isLowDiskSpace, OpenGuiHost } from "./opengui-host.ts";

const GiB = 1024 ** 3;

describe("Host storage health", () => {
  test.each([
    [0.5 * GiB, 500 * GiB, true],
    [4 * GiB, 200 * GiB, true],
    [20 * GiB, 200 * GiB, false],
    [2 * GiB, 10 * GiB, false],
  ])("free %d of %d bytes is low: %s", (free, total, expected) => {
    expect(isLowDiskSpace(free, total)).toBe(expected);
  });

  test("health reports storage pressure for the data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-health-"));
    try {
      const health = await new OpenGuiHost(root).healthWithStorage();
      expect(health.ok).toBe(true);
      expect(typeof health.lowDiskSpace).toBe("boolean");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
