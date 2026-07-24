import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { resolveNativeShell } from "./shell-resolution.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function executable(directory: string, name: string) {
  const path = join(directory, name);
  await writeFile(path, "");
  await chmod(path, 0o755);
  return path;
}

describe("native shell resolution", () => {
  test.skipIf(process.platform === "win32")(
    "uses Windows executable extensions when evaluating an explicit target platform",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "opengui-shell-resolution-"));
      temporaryDirectories.push(directory);
      const preferred = await executable(directory, "pwsh.exe");
      await executable(directory, "powershell.exe");

      expect(
        resolveNativeShell({
          platform: "win32",
          environment: { PATH: [directory, "/not-present"].join(delimiter) },
        }),
      ).toEqual({ executable: preferred, family: "powershell" });
    },
  );

  test("rejects a configured shell that is not executable", () => {
    expect(() =>
      resolveNativeShell({ configuredExecutable: "/definitely/not/a/shell", environment: {} }),
    ).toThrow("Configured shell is not executable");
  });
});
