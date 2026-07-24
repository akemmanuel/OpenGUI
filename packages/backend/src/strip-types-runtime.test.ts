import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

describe("Node strip-only runtime compatibility", () => {
  test("runtime backend modules avoid non-erasable TypeScript syntax", () => {
    const modules = [
      new URL("./create-backend-host.ts", import.meta.url),
      new URL("./path-policy/enforcement.ts", import.meta.url),
      new URL("./identity/audit.ts", import.meta.url),
    ];
    const paths = modules.map((moduleUrl) => fileURLToPath(moduleUrl));
    const source = `await Promise.all(${JSON.stringify(paths)}.map((path) => import(path)))`;

    expect(() =>
      execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", source],
        {
          stdio: "pipe",
        },
      ),
    ).not.toThrow();
  });
});
