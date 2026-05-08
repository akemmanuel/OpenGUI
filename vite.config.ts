import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const webBackendPort = Number(process.env.OPENGUI_WEB_BACKEND_PORT || 3001);

function openguiWebBackend() {
  let backend: ChildProcess | undefined;

  return {
    name: "opengui-web-backend",
    apply: "serve",
    configureServer(server: {
      httpServer?: { once: (event: "close", listener: () => void) => void };
    }) {
      if (process.env.OPENGUI_SKIP_WEB_BACKEND === "1" || process.env.NODE_ENV === "test") {
        return;
      }

      backend = spawn("bun", ["server/web-server.ts"], {
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
  plugins: [react(), tailwindcss(), openguiWebBackend()],
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
  run: {
    tasks: {
      dev: {
        command: "bun dev.ts",
        cache: false,
      },
      "dev:web": {
        command: "vp dev --host 127.0.0.1",
        cache: false,
      },
      start: {
        command: "NODE_ENV=production electron .",
        cache: false,
      },
      "start:web": {
        command: "HOST=0.0.0.0 NODE_ENV=production bun server/web-server.ts",
        cache: false,
      },
      "dist:linux": {
        command: "electron-builder --linux deb",
        cache: false,
      },
      "dist:mac": {
        command: "electron-builder --mac dmg",
        cache: false,
      },
      "dist:mac:arm64": {
        command: "electron-builder --mac dmg --arm64",
        cache: false,
      },
      "dist:win": {
        command: "electron-builder --win nsis",
        cache: false,
      },
      "dist:win:portable": {
        command: "electron-builder --win portable",
        cache: false,
      },
    },
  },
});
