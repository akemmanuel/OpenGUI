import "./build/suppress-node-deprecations.ts";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const vpBin = path.join(path.dirname(require.resolve("vite-plus/package.json")), "bin", "vp");
const webBackendPort = Number(process.env.OPENGUI_WEB_BACKEND_PORT || 3001);

function openguiElectronBuild() {
  return {
    name: "opengui-electron-build",
    apply: "build",
    async closeBundle() {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [vpBin, "build", "--config", "vite.electron.config.ts"],
          {
            cwd: configDir,
            stdio: "inherit",
            env: process.env,
          },
        );

        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(new Error(`Electron build failed with exit code ${code}`));
        });
      });
    },
  };
}

function openguiWebBackend() {
  let backend: ChildProcess | undefined;

  return {
    name: "opengui-web-backend",
    apply: "serve",
    configureServer(server: {
      httpServer?: { once: (event: "close", listener: () => void) => void };
    }) {
      if (
        process.env.OPENGUI_SKIP_WEB_BACKEND === "1" ||
        process.env.NODE_ENV === "test" ||
        process.env.VITEST === "true"
      ) {
        return;
      }

      backend = spawn(process.execPath, ["--experimental-strip-types", "server/web-server.ts"], {
        cwd: process.cwd(),
        stdio: "inherit",
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: String(webBackendPort),
          NODE_ENV: "development",
        },
      });

      server.httpServer?.once("close", () => {
        backend?.kill();
        backend = undefined;
      });
    },
  };
}

export default defineConfig({
  root: "src",
  base: "./",
  publicDir: false,
  plugins: [react(), tailwindcss(), openguiWebBackend(), openguiElectronBuild()],
  resolve: {
    alias: {
      "@": path.resolve(configDir, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${webBackendPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
});
