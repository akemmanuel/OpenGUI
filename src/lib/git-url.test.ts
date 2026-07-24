import { describe, expect, test } from "vite-plus/test";
import { buildPRUrl } from "./git-url";

describe("buildPRUrl", () => {
  test.each([
    [
      "git@github.com:open-gui/opengui.git",
      "feature/a b",
      "main",
      "https://github.com/open-gui/opengui/compare/main...feature%2Fa%20b",
    ],
    [
      "https://gitlab.example/team/app.git",
      "fix",
      "develop",
      "https://gitlab.example/team/app/compare/develop...fix",
    ],
  ])("builds an encoded compare URL for %s", (remote, branch, base, expected) => {
    expect(buildPRUrl(remote, branch, base)).toBe(expected);
  });

  test("rejects local paths and unsupported protocols", () => {
    expect(buildPRUrl("/tmp/repository", "feature")).toBeNull();
    expect(buildPRUrl("file:///tmp/repository", "feature")).toBeNull();
  });
});
