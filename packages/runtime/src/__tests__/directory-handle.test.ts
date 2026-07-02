import type { HarnessId } from "@opengui/protocol";
import { describe, expect, test, vi } from "vite-plus/test";
import { createDirectoryHandle } from "../directory-handle.ts";
import type { HarnessHandle } from "../open-gui.ts";

describe("createDirectoryHandle", () => {
  test("pins path and delegates connect/release/harness", async () => {
    const registerDirectory = vi.fn(async () => ({
      connectedHarnessIds: ["pi"] as HarnessId[],
      errors: [] as Array<{ harnessId: HarnessId; error: string }>,
    }));
    const releaseDirectory = vi.fn(async () => undefined);
    const boundHarness = { harnessId: "pi", directoryPath: "/repo" } as HarnessHandle;
    const createBoundHarness = vi.fn(() => boundHarness);

    const dir = createDirectoryHandle({
      path: "/repo",
      runtime: {
        harness: vi.fn(),
        createBoundHarness,
        registerDirectory,
        releaseDirectory,
      },
    });

    expect(dir.path).toBe("/repo");
    await dir.connect({ harnesses: ["pi"] });
    expect(registerDirectory).toHaveBeenCalledWith({ directory: "/repo", harnessIds: ["pi"] });

    await dir.release({ harnesses: ["pi"] });
    expect(releaseDirectory).toHaveBeenCalledWith({ directory: "/repo", harnessIds: ["pi"] });

    const pi = dir.harness("pi");
    expect(createBoundHarness).toHaveBeenCalledWith("pi", "/repo");
    expect(pi).toBe(boundHarness);
  });
});
