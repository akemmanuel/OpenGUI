import { describe, expect, test } from "vite-plus/test";
import { createElectronRuntimePackage, packageIdForImport } from "./electron-package-metadata";

describe("Electron package metadata", () => {
  test("copies only runtime fields into the packaged sidecar manifest", () => {
    expect(
      createElectronRuntimePackage({
        name: "opengui",
        version: "1.2.3",
        type: "module",
        main: "dist-electron/main.js",
        dependencies: { hono: "4.0.0" },
        devDependencies: { electron: "99.0.0" },
      } as never),
    ).toEqual({
      name: "opengui",
      version: "1.2.3",
      type: "module",
      main: "dist-electron/main.js",
      dependencies: { hono: "4.0.0" },
    });
  });

  test.each([
    ["electron", "electron"],
    ["electron/main", "electron"],
    ["@opengui/backend", "@opengui/backend"],
    ["@opengui/backend/routes", "@opengui/backend"],
  ])("resolves package boundary for %s", (specifier, expected) => {
    expect(packageIdForImport(specifier)).toBe(expected);
  });
});
