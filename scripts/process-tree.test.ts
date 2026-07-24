import { describe, expect, test, vi } from "vite-plus/test";
import { terminateDetachedProcessTree } from "./process-tree.ts";

describe("detached process-tree cleanup", () => {
  test("uses taskkill tree mode on Windows so Vite and Host grandchildren cannot leak", async () => {
    const execute = vi.fn(async () => undefined);

    await terminateDetachedProcessTree(1234, {
      platform: "win32",
      force: true,
      execute,
      signal: vi.fn(),
    });

    expect(execute).toHaveBeenCalledWith("taskkill", ["/pid", "1234", "/t", "/f"]);
  });

  test("signals the detached process group on POSIX", async () => {
    const signal = vi.fn();

    await terminateDetachedProcessTree(1234, {
      platform: "linux",
      force: false,
      execute: vi.fn(),
      signal,
    });

    expect(signal).toHaveBeenCalledWith(-1234, "SIGTERM");
  });
});
