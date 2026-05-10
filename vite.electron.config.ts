import { builtinModules } from "node:module";
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

function isExternal(id: string) {
  if (id.startsWith("node:")) return true;
  const [scopeOrName, packageName] = id.split("/");
  const packageId = scopeOrName?.startsWith("@") ? `${scopeOrName}/${packageName}` : scopeOrName;
  return Boolean(packageId && externals.has(packageId));
}

export default defineConfig({
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
