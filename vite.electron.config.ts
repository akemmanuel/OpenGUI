import "./build/suppress-node-deprecations.ts";

import { builtinModules } from "node:module";
import { build as buildWithEsbuild } from "esbuild";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const entries = {
  main: "main.ts",
  preload: "preload.ts",
  "opencode-bridge": "opencode-bridge.ts",
  "claude-code-bridge": "claude-code-bridge.ts",
  "codex-bridge": "codex-bridge.ts",
  "pi-bridge": "pi-bridge.ts",
  "pi-daemon-server": "pi-daemon-server.ts",
  "settings-store": "settings-store.ts",
  "main/update-manager": "main/update-manager.ts",
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

export default defineConfig({
  plugins: [
    {
      name: "opengui-preload-cjs",
      apply: "build",
      async closeBundle() {
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
