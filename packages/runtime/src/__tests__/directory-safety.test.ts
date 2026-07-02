import { describe, expect, test } from "vite-plus/test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isWithinAllowedRoot,
  normalizeAllowedRoots,
  resolveSafeDirectory,
} from "../directory-safety.ts";

describe("directory-safety", () => {
  test("normalizeAllowedRoots resolves paths", () => {
    const home = homedir();
    const roots = normalizeAllowedRoots([home]);
    expect(roots).toEqual([home]);
  });

  test("isWithinAllowedRoot accepts children", () => {
    const root = join(homedir(), "opengui-sdk-test-root");
    const child = join(root, "repo");
    expect(isWithinAllowedRoot(child, [root])).toBe(true);
    expect(isWithinAllowedRoot("/etc/passwd", [root])).toBe(false);
  });

  test("resolveSafeDirectory resolves home", async () => {
    const home = homedir();
    const actual = await resolveSafeDirectory(home, [home]);
    expect(actual).toBe(home);
  });
});
