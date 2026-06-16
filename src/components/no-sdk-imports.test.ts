import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(process.cwd(), "src");
const OPENCODE_SDK_IMPORT = ["@opencode-ai", "sdk"].join("/");
const ALLOWED_DIRECT_SDK_IMPORTS = new Set([
  join("src", "agents", "backend.ts"),
  join("src", "agents", "shared.ts"),
  join("src", "agents", "shared.test.ts"),
  join("src", "agents", "protocol", "opencode-map.ts"),
  join("src", "agents", "protocol", "opencode-map.test.ts"),
]);

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
  test("frontend modules do not import Harness SDK types directly", () => {
    const offenders = collectSourceFiles(SRC_DIR).filter((file) => {
      const relativePath = relative(process.cwd(), file);
      return (
        readFileSync(file, "utf8").includes(OPENCODE_SDK_IMPORT) &&
        !ALLOWED_DIRECT_SDK_IMPORTS.has(relativePath)
      );
    });

    expect(offenders.map((file) => relative(process.cwd(), file))).toEqual([]);
  });
});
