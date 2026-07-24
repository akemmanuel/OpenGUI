import { describe, expect, test } from "vite-plus/test";
import { getPlatformPath } from "./ensure-electron.mjs";

describe("Electron artifact selection", () => {
  test.each([
    ["darwin", "Electron.app/Contents/MacOS/Electron"],
    ["linux", "electron"],
    ["win32", "electron.exe"],
  ])("uses the packaged executable path on %s", (platform, expected) => {
    expect(getPlatformPath(platform)).toBe(expected);
  });

  test("rejects platforms without Electron releases", () => {
    expect(() => getPlatformPath("plan9")).toThrow("Electron builds are not available");
  });
});
