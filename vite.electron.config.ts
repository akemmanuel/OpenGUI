import "./build/suppress-node-deprecations.ts";

import { copyFile, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build as buildWithEsbuild } from "esbuild";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };
import {
  createElectronRuntimePackage,
  packageIdForImport,
} from "./scripts/electron-package-metadata.ts";

const entries = {
  main: "main.ts",
  preload: "preload.ts",
  "settings-store": "settings-store.ts",
  "lib/window-broadcast": "lib/window-broadcast.ts",
};
const require = createRequire(import.meta.url);

const externals = new Set([
  "electron",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
]);

const bundledPackagePrefixes: string[] = [];

function isBundledPackage(id: string) {
  return bundledPackagePrefixes.some((prefix) => id === prefix || id.startsWith(`${prefix}/`));
}

function isExternal(id: string) {
  if (id.startsWith("node:")) return true;
  if (isBundledPackage(id)) return false;
  const packageId = packageIdForImport(id);
  return Boolean(packageId && externals.has(packageId));
}

const nodeEsmCompatBanner = [
  "import { createRequire as __openguiCreateRequire } from 'node:module';",
  "import { fileURLToPath as __openguiFileURLToPath } from 'node:url';",
  "import { dirname as __openguiDirname } from 'node:path';",
  "const require = __openguiCreateRequire(import.meta.url);",
  "const __filename = __openguiFileURLToPath(import.meta.url);",
  "const __dirname = __openguiDirname(__filename);",
].join(" ");

export default defineConfig({
  plugins: [
    {
      name: "opengui-electron-artifacts",
      apply: "build",
      async closeBundle() {
        const runtimePackage = createElectronRuntimePackage(pkg);

        await writeFile(
          "dist-electron/package.json",
          `${JSON.stringify(runtimePackage, null, 2)}\n`,
        );
        await buildWithEsbuild({
          entryPoints: ["preload.ts"],
          outfile: "dist-electron/preload.cjs",
          bundle: true,
          platform: "node",
          format: "cjs",
          target: "node22",
          sourcemap: true,
          minify: true,
          external: ["electron"],
        });

        await buildWithEsbuild({
          entryPoints: ["server/web-server.ts"],
          outfile: "dist-electron/backend.js",
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node22",
          sourcemap: true,
          minify: true,
          external: ["electron"],
          banner: {
            js: nodeEsmCompatBanner,
          },
        });
        await copyFile(
          join(
            dirname(require.resolve("@silvia-odwyer/photon-node/package.json")),
            "photon_rs_bg.wasm",
          ),
          "dist-electron/photon_rs_bg.wasm",
        );
      },
    },
  ],
  ssr: {
    noExternal: bundledPackagePrefixes,
  },
  build: {
    emptyOutDir: true,
    minify: true,
    outDir: "dist-electron",
    sourcemap: true,
    ssr: true,
    target: "node22",
    rollupOptions: {
      external: isExternal,
      input: entries,
      output: {
        entryFileNames: "[name].js",
        format: "es",
      },
    },
  },
});
