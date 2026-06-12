import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { getProjectName, normalizeProjectPath } from "../path";

describe("normalizeProjectPath", () => {
  test("trims whitespace and trailing separators", () => {
    expect(normalizeProjectPath("  /repo/project///  ")).toBe("/repo/project");
    expect(normalizeProjectPath("C:\\repo\\project\\")).toBe("C:\\repo\\project");
  });

  test("preserves filesystem roots", () => {
    expect(normalizeProjectPath("/")).toBe("/");
    expect(normalizeProjectPath("\\\\")).toBe("\\");
    expect(normalizeProjectPath("C:/")).toBe("C:/");
    expect(normalizeProjectPath("C:\\")).toBe("C:\\");
  });

  test("returns empty strings for blank paths", () => {
    expect(normalizeProjectPath("   ")).toBe("");
  });
});

describe("getProjectName", () => {
  test("uses normalized trailing directory name", () => {
    expect(getProjectName("/repo/project/")).toBe("project");
    expect(getProjectName("C:\\repo\\project\\")).toBe("project");
  });

  test("falls back for roots or blank paths", () => {
    expect(getProjectName("/")).toBe("repo");
    expect(getProjectName("", "fallback")).toBe("fallback");
  });
});
