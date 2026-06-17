import "./build/suppress-node-deprecations.ts";

import { copyFile, readdir, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { join } from "node:path";
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

const bundledPackagePrefixes = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

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

const require = createRequire(import.meta.url);

const nodeEsmCompatBanner = [
  "import { createRequire as __openguiCreateRequire } from 'node:module';",
  "import { fileURLToPath as __openguiFileURLToPath } from 'node:url';",
  "import { dirname as __openguiDirname } from 'node:path';",
  "const require = __openguiCreateRequire(import.meta.url);",
  "const __filename = __openguiFileURLToPath(import.meta.url);",
  "const __dirname = __openguiDirname(__filename);",
].join(" ");

async function findPhotonWasm() {
  try {
    return require.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm");
  } catch {
    // Fall back to pnpm's virtual store layout when package exports do not expose the wasm file.
  }

  const pnpmDir = join(process.cwd(), "node_modules", ".pnpm");
  const entries = await readdir(pnpmDir, { withFileTypes: true });
  const photonEntry = entries.find(
    (entry) => entry.isDirectory() && entry.name.startsWith("@silvia-odwyer+photon-node@"),
  );
  if (!photonEntry)
    throw new Error("Could not find @silvia-odwyer/photon-node in node_modules/.pnpm");
  return join(
    pnpmDir,
    photonEntry.name,
    "node_modules",
    "@silvia-odwyer",
    "photon-node",
    "photon_rs_bg.wasm",
  );
}

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
        await copyFile(await findPhotonWasm(), "dist-electron/photon_rs_bg.wasm");

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

        await buildWithEsbuild({
          entryPoints: ["packages/runtime/src/adapters/pi-daemon-server.ts"],
          outfile: "dist-electron/pi-daemon-server.js",
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
