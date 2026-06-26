import "./build/suppress-node-deprecations.ts";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { once } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin, ViteDevServer } from "vite";
import { defineConfig } from "vite-plus";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const vpBin = path.join(path.dirname(require.resolve("vite-plus/package.json")), "bin", "vp");
const webBackendPort = Number(process.env.OPENGUI_WEB_BACKEND_PORT || 3001);
const webBackendHost = process.env.OPENGUI_WEB_BACKEND_HOST || "127.0.0.1";

function openguiElectronBuild(): Plugin {
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

function shouldRestartWebBackend(file: string) {
  const normalized = file.replaceAll("\\", "/");
  return (
    normalized.includes("/server/") ||
    normalized.includes("/packages/runtime/") ||
    normalized.includes("/lib/harness-adapter-kit") ||
    normalized.includes("/lib/grok-acp-client")
  );
}

function freeWebBackendPort(port: number) {
  if (process.platform === "win32") return;
  spawnSync("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
}

async function stopWebBackendChild(child: ChildProcess | undefined) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
}

function openguiWebBackend(): Plugin {
  let backend: ChildProcess | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let starting: Promise<void> | undefined;

  return {
    name: "opengui-web-backend",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      if (
        process.env.OPENGUI_SKIP_WEB_BACKEND === "1" ||
        process.env.NODE_ENV === "test" ||
        process.env.VITEST === "true"
      ) {
        return;
      }

      const startBackend = async (options: { freePort?: boolean } = {}) => {
        if (starting) await starting;
        starting = (async () => {
          await stopWebBackendChild(backend);
          backend = undefined;
          if (options.freePort) {
            freeWebBackendPort(webBackendPort);
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          const child = spawn(
            process.execPath,
            ["--experimental-strip-types", "server/web-server.ts"],
            {
              cwd: process.cwd(),
              stdio: "inherit",
              env: {
                ...process.env,
                HOST: webBackendHost,
                PORT: String(webBackendPort),
                NODE_ENV: "development",
              },
            },
          );
          child.once("exit", (code, signal) => {
            if (backend !== child) return;
            backend = undefined;
            if (code === 0 || code === null) return;
            console.error(
              `[opengui-web-backend] Backend exited (${signal ?? code}). ` +
                `If you see EADDRINUSE on port ${webBackendPort}, stop the old backend and restart dev.`,
            );
          });
          backend = child;
        })();
        try {
          await starting;
        } finally {
          starting = undefined;
        }
      };

      void startBackend({ freePort: true });

      server.watcher?.on("change", (file) => {
        if (!shouldRestartWebBackend(file)) return;
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          restartTimer = undefined;
          console.log("[opengui-web-backend] Restarting backend after change:", file);
          void startBackend({ freePort: true });
        }, 250);
      });

      server.httpServer?.once("close", () => {
        if (restartTimer) clearTimeout(restartTimer);
        void stopWebBackendChild(backend).finally(() => {
          backend = undefined;
        });
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
