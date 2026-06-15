import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const COMPONENTS_DIR = join(process.cwd(), "src", "components");
const OPENCODE_SDK_IMPORT = ["@opencode-ai", "sdk"].join("/");

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) files.push(path);
  }
  return files;
}

describe("Frontend presentation seam", () => {
  test("components do not import Harness SDK types directly", () => {
    const offenders = collectSourceFiles(COMPONENTS_DIR).filter((file) =>
      readFileSync(file, "utf8").includes(OPENCODE_SDK_IMPORT),
    );

    expect(offenders.map((file) => relative(process.cwd(), file))).toEqual([]);
  });
});
