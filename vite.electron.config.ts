import "./build/suppress-node-deprecations.ts";

import { writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { build as buildWithEsbuild } from "esbuild";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const entries = {
  main: "main.ts",
  preload: "preload.ts",
  "settings-store": "settings-store.ts",
  "lib/window-broadcast": "lib/window-broadcast.ts",
};

const externals = new Set([
  "electron",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
]);

const bundledPackagePrefixes: string[] = [];

function packageIdFor(id: string) {
  const [scopeOrName, packageName] = id.split("/");
  return scopeOrName?.startsWith("@") ? `${scopeOrName}/${packageName}` : scopeOrName;
}

function isBundledPackage(id: string) {
  return bundledPackagePrefixes.some((prefix) => id === prefix || id.startsWith(`${prefix}/`));
}

function isExternal(id: string) {
  if (id.startsWith("node:")) return true;
  if (isBundledPackage(id)) return false;
  const packageId = packageIdFor(id);
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
        const runtimePackage = {
          name: pkg.name,
          version: pkg.version,
          type: pkg.type,
          main: pkg.main,
          dependencies: pkg.dependencies,
        };

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
          target: "node20",
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
          target: "node20",
          sourcemap: true,
          minify: true,
          external: ["electron"],
          banner: {
            js: nodeEsmCompatBanner,
          },
        });
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
    target: "node20",
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
