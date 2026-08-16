import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { App } from "electron";
import { Effect } from "effect";
import { runEffect, tryPromiseEffect } from "../lib/effect-runtime.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_PROFILE_KEY = "desktop:backend-profile";
const DEFAULT_EXTERNAL_URL = "http://127.0.0.1:3000";
const SIDE_CAR_HOST = "127.0.0.1";
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 5_000;

export type BackendProfileMode = "local-managed" | "local-external" | "remote";
export type BackendStatus = "starting" | "running" | "stopped" | "crashed";

export interface DesktopBackendProfile {
  id: string;
  name: string;
  mode: BackendProfileMode;
  url: string;
  token?: string;
  stopWithApp?: boolean;
}

export interface BackendRuntimeConfig {
  url: string;
  token: string | null;
  mode: BackendProfileMode;
  managed: boolean;
}

interface SettingsStoreLike {
  get(key: string): string | null;
}

export interface BackendSidecarDependencies {
  spawn: typeof spawn;
  findAvailablePort: () => Promise<number>;
  waitForHealth: (
    url: string,
    token: string | null,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  resolveBackendEntrypoint: (app: App) => string;
  randomUUID: () => string;
  mkdirSync: typeof mkdirSync;
  homedir: () => string;
}

export interface CreateBackendSidecarControllerOptions {
  app: App;
  settingsStore: SettingsStoreLike;
  isDev: boolean;
  devServerUrl: string;
  onStatusChange?: (status: BackendStatus) => void;
  dependencies?: Partial<BackendSidecarDependencies>;
}

interface ManagedChildState {
  child: ChildProcess;
  config: BackendRuntimeConfig;
}

export function resolveManagedRuntime(entrypoint: string, executable = process.execPath) {
  const args = entrypoint.endsWith(".ts")
    ? ["--experimental-strip-types", entrypoint]
    : [entrypoint];

  return {
    command: executable,
    args,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseBackendProfile(raw: string | null): DesktopBackendProfile | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!isPlainObject(value)) return null;
    const mode = value.mode;
    if (mode !== "local-managed" && mode !== "local-external" && mode !== "remote") return null;
    const url = typeof value.url === "string" && value.url.trim() ? value.url.trim() : "";
    return {
      id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : mode,
      name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : mode,
      mode,
      url,
      token: typeof value.token === "string" && value.token.trim() ? value.token.trim() : undefined,
      stopWithApp: value.stopWithApp !== false,
    };
  } catch {
    return null;
  }
}

export function defaultBackendProfile(): DesktopBackendProfile {
  return {
    id: "local-managed",
    name: "Local Managed Backend",
    mode: "local-managed",
    url: DEFAULT_EXTERNAL_URL,
    stopWithApp: true,
  };
}

export function loadBackendProfile(
  settingsStore: SettingsStoreLike,
  environment: NodeJS.ProcessEnv = process.env,
): DesktopBackendProfile {
  const envMode = environment.OPENGUI_BACKEND_MODE;
  const envUrl = environment.OPENGUI_BACKEND_URL?.trim();
  const envToken = environment.OPENGUI_BACKEND_TOKEN?.trim();
  const forceSidecar = environment.OPENGUI_USE_SIDECAR === "1";

  if (forceSidecar) return defaultBackendProfile();

  if (envMode === "local-managed") return defaultBackendProfile();

  if (
    (envMode === "local-external" || envMode === "remote") &&
    envUrl &&
    (envUrl.startsWith("http://") || envUrl.startsWith("https://"))
  ) {
    return {
      id: envMode,
      name: envMode,
      mode: envMode,
      url: envUrl,
      token: envToken || undefined,
      stopWithApp: false,
    };
  }

  const stored = parseBackendProfile(settingsStore.get(BACKEND_PROFILE_KEY));
  if (!stored) return defaultBackendProfile();
  if (stored.mode === "local-managed") return { ...defaultBackendProfile(), ...stored };
  if (!stored.url || (!stored.url.startsWith("http://") && !stored.url.startsWith("https://"))) {
    return defaultBackendProfile();
  }
  return stored;
}

async function findAvailablePort() {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, SIDE_CAR_HOST, () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate backend port"));
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function waitForHealth(
  url: string,
  token: string | null,
  timeoutMs = HEALTH_TIMEOUT_MS,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(`${url.replace(/\/+$/, "")}/api/health`, {
        headers,
        signal,
      });
      if (response.ok) return;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await delay(Math.min(HEALTH_POLL_INTERVAL_MS, remaining), undefined, { signal });
    }
  }
  throw new Error(`Timed out waiting for backend health at ${url}`);
}

export function selectBackendEntrypoint(
  input: {
    override?: string;
    isPackaged: boolean;
    resourcesPath: string;
    appPath: string;
    moduleDirectory: string;
    cwd: string;
  },
  exists: (candidate: string) => boolean = existsSync,
) {
  if (input.override) return input.override;
  const unpackedBundled = path.resolve(
    input.resourcesPath,
    "app.asar.unpacked",
    "dist-electron",
    "backend.js",
  );
  if (input.isPackaged && exists(unpackedBundled)) return unpackedBundled;
  const candidates = [
    path.resolve(input.appPath, "dist-electron", "backend.js"),
    path.resolve(input.moduleDirectory, "backend.js"),
    path.resolve(input.cwd, "dist-electron", "backend.js"),
    unpackedBundled,
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  const source = path.resolve(input.appPath, "server", "web-server.ts");
  if (exists(source)) return source;
  throw new Error("Could not find backend entrypoint for Desktop Shell sidecar");
}

function resolveBackendEntrypoint(app: App) {
  const override = process.env.OPENGUI_BACKEND_ENTRY?.trim();
  return selectBackendEntrypoint({
    override,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    moduleDirectory: __dirname,
    cwd: process.cwd(),
  });
}

async function stopChild(childState: ManagedChildState | null) {
  if (!childState?.child || childState.child.killed || childState.child.exitCode !== null) return;

  const child = childState.child;
  // Subscribe before sending the signal. Small children can exit before a lazy
  // Effect starts observing them, turning a clean stop into a false timeout.
  const exitPromise = once(child, "exit");
  const waitForExit = tryPromiseEffect(() => exitPromise);

  await runEffect(
    Effect.gen(function* () {
      child.kill("SIGTERM");
      yield* waitForExit.pipe(
        Effect.timeoutFail({
          duration: STOP_TIMEOUT_MS,
          onTimeout: () => new Error("Timed out stopping backend child"),
        }),
        Effect.catchAll(() =>
          Effect.gen(function* () {
            child.kill("SIGKILL");
            yield* waitForExit.pipe(Effect.catchAll(() => Effect.void));
          }),
        ),
      );
    }),
  );
}

export function createBackendSidecarController(options: CreateBackendSidecarControllerOptions) {
  const dependencies: BackendSidecarDependencies = {
    spawn,
    findAvailablePort,
    waitForHealth,
    resolveBackendEntrypoint,
    randomUUID,
    mkdirSync,
    homedir,
    ...options.dependencies,
  };
  let status: BackendStatus = "stopped";
  let runtimeConfig: BackendRuntimeConfig | null = null;
  let childState: ManagedChildState | null = null;
  let currentProfile: DesktopBackendProfile | null = null;
  let stoppingForShutdown = false;
  let startPromise: Promise<BackendRuntimeConfig> | null = null;
  let restartPromise: Promise<BackendRuntimeConfig> | null = null;
  let healthController: AbortController | null = null;

  const setStatus = (nextStatus: BackendStatus) => {
    status = nextStatus;
    options.onStatusChange?.(nextStatus);
  };

  const spawnManagedBackend = async (
    profile: DesktopBackendProfile,
    preferred?: { port?: number; token?: string | null },
  ) => {
    const entrypoint = dependencies.resolveBackendEntrypoint(options.app);
    const runtime = resolveManagedRuntime(entrypoint);
    const port = preferred?.port ?? (await dependencies.findAvailablePort());
    const token = preferred?.token || dependencies.randomUUID();
    const url = `http://${SIDE_CAR_HOST}:${port}`;
    const dataDir = path.join(options.app.getPath("userData"), "backend");

    // Keep the managed backend's process cwd inside OpenGUI-owned app data.
    // Using the app/source directory as cwd can make macOS show privacy prompts
    // (for example “OpenGUI.app wants access to Documents”) when the app is run
    // from a protected user folder, even though the backend only needs its data dir.
    dependencies.mkdirSync(dataDir, { recursive: true });

    const child = dependencies.spawn(runtime.command, runtime.args, {
      cwd: dataDir,
      env: {
        ...runtime.env,
        HOST: SIDE_CAR_HOST,
        PORT: String(port),
        OPENGUI_AUTH_TOKEN: token,
        OPENGUI_ALLOWED_ROOTS: process.env.OPENGUI_ALLOWED_ROOTS || dependencies.homedir(),
        OPENGUI_DATA_DIR: dataDir,
        OPENGUI_CORS_ORIGIN: process.env.OPENGUI_CORS_ORIGIN || "http://localhost:3000",
        OPENGUI_MODE: "desktop-sidecar",
        OPENGUI_SERVER_MODE: "desktop-sidecar",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data) => {
      process.stdout.write(`[sidecar] ${String(data)}`);
    });
    child.stderr?.on("data", (data) => {
      process.stderr.write(`[sidecar] ${String(data)}`);
    });
    child.on("exit", (code, signal) => {
      childState = null;
      runtimeConfig = null;
      if (stoppingForShutdown) {
        setStatus("stopped");
        return;
      }
      console.error(`Backend sidecar exited`, { code, signal });
      setStatus("crashed");
    });
    child.on("error", (error) => {
      console.error("Backend sidecar failed", error);
      if (!stoppingForShutdown) setStatus("crashed");
    });

    const config: BackendRuntimeConfig = {
      url,
      token,
      mode: profile.mode,
      managed: true,
    };

    childState = { child, config };
    healthController = new AbortController();
    try {
      await Promise.race([
        dependencies.waitForHealth(url, token, HEALTH_TIMEOUT_MS, healthController.signal),
        once(child, "exit").then(([code, signal]) => {
          throw new Error(`Backend sidecar exited before becoming healthy (${code ?? signal})`);
        }),
      ]);
      runtimeConfig = config;
      return config;
    } catch (error) {
      healthController.abort();
      await stopChild(childState);
      childState = null;
      runtimeConfig = null;
      if (!stoppingForShutdown) setStatus("crashed");
      throw error;
    } finally {
      healthController = null;
    }
  };

  const start = async () => {
    if (startPromise) return await startPromise;
    if (runtimeConfig && (!childState || childState.child.exitCode === null)) return runtimeConfig;

    startPromise = (async () => {
      const profile = loadBackendProfile(options.settingsStore);
      currentProfile = profile;

      if (
        options.isDev &&
        process.env.OPENGUI_USE_SIDECAR !== "1" &&
        profile.mode === "local-managed"
      ) {
        runtimeConfig = {
          url: options.devServerUrl,
          token: process.env.OPENGUI_BACKEND_TOKEN?.trim() || null,
          mode: profile.mode,
          managed: false,
        };
        setStatus("running");
        return runtimeConfig;
      }

      if (profile.mode !== "local-managed") {
        runtimeConfig = {
          url: profile.url,
          token: profile.token || null,
          mode: profile.mode,
          managed: false,
        };
        setStatus("running");
        return runtimeConfig;
      }

      setStatus("starting");
      const config = await spawnManagedBackend(profile);
      setStatus("running");
      return config;
    })();

    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  };

  return {
    async start() {
      return await start();
    },
    async restart() {
      if (restartPromise) return await restartPromise;
      restartPromise = (async () => {
        if (startPromise) await startPromise;
        const current = runtimeConfig;
        if (!current?.managed) return await start();
        const currentPort = Number(new URL(current.url).port || 0) || undefined;
        const profile = currentProfile ?? loadBackendProfile(options.settingsStore);
        stoppingForShutdown = true;
        healthController?.abort();
        await stopChild(childState);
        stoppingForShutdown = false;
        runtimeConfig = null;
        childState = null;
        setStatus("starting");
        const config = await spawnManagedBackend(profile, {
          port: currentPort,
          token: current.token,
        });
        runtimeConfig = config;
        setStatus("running");
        return config;
      })();
      try {
        return await restartPromise;
      } finally {
        restartPromise = null;
      }
    },
    async stop() {
      healthController?.abort();
      if (startPromise) await startPromise.catch(() => undefined);
      if (restartPromise) await restartPromise.catch(() => undefined);
      if (currentProfile?.mode === "local-managed" && currentProfile.stopWithApp === false) {
        setStatus("running");
        return;
      }
      stoppingForShutdown = true;
      await stopChild(childState);
      childState = null;
      runtimeConfig = null;
      setStatus("stopped");
    },
    getConfig() {
      return runtimeConfig;
    },
    getStatus() {
      return status;
    },
  };
}
