/**
 * Dev script - replaces concurrently + wait-on.
 * Starts the Vite+ dev server, waits for it to be ready, then launches Electron.
 * Kills both processes on exit.
 */

import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const host = "127.0.0.1";
const port = Number(process.env.OPENGUI_VITE_PORT || 5173);
const backendPort = Number(process.env.OPENGUI_WEB_BACKEND_PORT || 3001);
const url = `http://${host}:${port}`;
const backendUrl = `http://${host}:${backendPort}`;

const build = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "scripts/build-electron.ts"],
  {
    stdio: "inherit",
    env: process.env,
  },
);

if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn("vp", ["dev", "--host", host, "--port", String(port)], {
  stdio: "inherit",
  env: process.env,
});

const maxAttempts = 60;

for (let i = 0; i < maxAttempts; i++) {
  try {
    await fetch(url);
    await fetch(`${backendUrl}/api/health`);
    break;
  } catch {
    if (i === maxAttempts - 1) {
      console.error(`Server did not start within ${maxAttempts} seconds`);
      server.kill();
      process.exit(1);
    }
    await sleep(1000);
  }
}

const electronEnv = { ...process.env };
delete electronEnv.ELECTRON_RUN_AS_NODE;

const electronArgs = ["exec", "electron", ".", "--enable-logging=stderr"];
if (process.env.OPENGUI_REMOTE_DEBUGGING_PORT) {
  electronArgs.push(`--remote-debugging-port=${process.env.OPENGUI_REMOTE_DEBUGGING_PORT}`);
}

const electron = spawn("pnpm", electronArgs, {
  stdio: "inherit",
  env: {
    ...electronEnv,
    OPENGUI_DEV_SERVER_URL: url,
    OPENGUI_BACKEND_MODE: "local-external",
    OPENGUI_BACKEND_URL: backendUrl,
    ELECTRON_ENABLE_LOGGING: "1",
    ELECTRON_ENABLE_STACK_DUMPING: "1",
  },
});

const exitCode = await new Promise<number>((resolve, reject) => {
  electron.once("error", reject);
  electron.once("exit", (code) => resolve(code ?? 0));
});

server.kill();
process.exit(exitCode);
