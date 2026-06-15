import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { isFilePathLike } from "./file-paths";

describe("isFilePathLike", () => {
  test("detects hidden dotfiles as file paths", () => {
    expect(isFilePathLike(".env")).toBe(true);
    expect(isFilePathLike("config/.gitignore")).toBe(true);
  });

  test("detects common extensionless file paths", () => {
    expect(isFilePathLike("Dockerfile")).toBe(true);
    expect(isFilePathLike("Procfile")).toBe(true);
    expect(isFilePathLike("README")).toBe(true);
    expect(isFilePathLike("/etc/hosts")).toBe(true);
  });

  test("detects bare filenames with extensions", () => {
    expect(isFilePathLike("README.md")).toBe(true);
    expect(isFilePathLike("package.json")).toBe(true);
  });
});
