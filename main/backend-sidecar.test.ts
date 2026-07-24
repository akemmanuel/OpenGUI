import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { App } from "electron";
import {
  createBackendSidecarController,
  loadBackendProfile,
  parseBackendProfile,
  resolveManagedRuntime,
  selectBackendEntrypoint,
} from "./backend-sidecar";

const originalEnvironment = { ...process.env };
const directories: string[] = [];

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function app(userData = "/tmp/opengui-test-user-data"): App {
  return {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => userData,
  } as unknown as App;
}

class FakeChild extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  stdout = null;
  stderr = null;
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killed = true;
    this.signals.push(signal);
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

function managedHarness(
  overrides: {
    waitForHealth?: (signal?: AbortSignal) => Promise<void>;
    children?: FakeChild[];
  } = {},
) {
  process.env.OPENGUI_USE_SIDECAR = "1";
  const children = overrides.children ?? [];
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const controller = createBackendSidecarController({
    app: app(),
    settingsStore: { get: () => null },
    isDev: false,
    devServerUrl: "http://127.0.0.1:5173",
    dependencies: {
      spawn: spawn as unknown as typeof spawnProcess,
      findAvailablePort: async () => 43123,
      waitForHealth: async (_url, _token, _timeout, signal) =>
        await (overrides.waitForHealth?.(signal) ?? Promise.resolve()),
      resolveBackendEntrypoint: () => "/app/backend.js",
      randomUUID: () => "fixed-token",
      mkdirSync: vi.fn() as never,
      homedir: () => "/home/person",
    },
  });
  return { controller, spawn, children };
}

describe("Desktop backend profile", () => {
  test.each([
    [null, null],
    ["not-json", null],
    ["[]", null],
    [JSON.stringify({ mode: "unknown", url: "https://host" }), null],
    [
      JSON.stringify({ mode: "remote", url: " https://host.example ", token: " secret " }),
      {
        id: "remote",
        name: "remote",
        mode: "remote",
        url: "https://host.example",
        token: "secret",
        stopWithApp: true,
      },
    ],
  ])("parses profile %j", (raw, expected) => {
    expect(parseBackendProfile(raw)).toEqual(expected);
  });

  test.each([
    [
      {
        OPENGUI_USE_SIDECAR: "1",
        OPENGUI_BACKEND_MODE: "remote",
        OPENGUI_BACKEND_URL: "https://env",
      },
      JSON.stringify({ mode: "remote", url: "https://stored" }),
      "local-managed",
      "http://127.0.0.1:3000",
    ],
    [
      {
        OPENGUI_BACKEND_MODE: "remote",
        OPENGUI_BACKEND_URL: "https://env",
        OPENGUI_BACKEND_TOKEN: "env-token",
      },
      JSON.stringify({ mode: "local-external", url: "http://stored" }),
      "remote",
      "https://env",
    ],
    [
      { OPENGUI_BACKEND_MODE: "remote", OPENGUI_BACKEND_URL: "file:///invalid" },
      JSON.stringify({ mode: "local-external", url: "http://stored" }),
      "local-external",
      "http://stored",
    ],
    [{}, "malformed", "local-managed", "http://127.0.0.1:3000"],
  ])("applies environment and stored-profile precedence", (environment, stored, mode, url) => {
    expect(loadBackendProfile({ get: () => stored }, environment)).toMatchObject({ mode, url });
  });
});

describe("packaged backend entrypoint selection", () => {
  const paths = {
    override: undefined,
    isPackaged: true,
    resourcesPath: "/opt/OpenGUI/resources",
    appPath: "/opt/OpenGUI/resources/app.asar",
    moduleDirectory: "/opt/OpenGUI/resources/app.asar/dist-electron/main",
    cwd: "/unrelated",
  };

  test("prefers the explicitly configured entrypoint", () => {
    expect(
      selectBackendEntrypoint({ ...paths, override: "/custom/backend.mjs" }, () => false),
    ).toBe("/custom/backend.mjs");
  });

  test("prefers the asar-unpacked sidecar in packaged applications", () => {
    const expected = "/opt/OpenGUI/resources/app.asar.unpacked/dist-electron/backend.js";
    expect(selectBackendEntrypoint(paths, (candidate) => candidate === expected)).toBe(expected);
  });

  test("uses source TypeScript only as the development fallback", () => {
    const source = "/workspace/server/web-server.ts";
    expect(
      selectBackendEntrypoint(
        { ...paths, isPackaged: false, appPath: "/workspace" },
        (candidate) => candidate === source,
      ),
    ).toBe(source);
  });

  test("fails clearly instead of spawning an undefined entrypoint", () => {
    expect(() => selectBackendEntrypoint(paths, () => false)).toThrow(
      "Could not find backend entrypoint",
    );
  });
});

describe("Desktop backend sidecar controller", () => {
  test("connects to an explicitly configured Remote Host without spawning a child", async () => {
    process.env.OPENGUI_BACKEND_MODE = "remote";
    process.env.OPENGUI_BACKEND_URL = "https://host.example/api";
    process.env.OPENGUI_BACKEND_TOKEN = "remote-token";
    const statuses: string[] = [];
    const controller = createBackendSidecarController({
      app: app(),
      settingsStore: { get: () => null },
      isDev: false,
      devServerUrl: "http://127.0.0.1:5173",
      onStatusChange: (status) => statuses.push(status),
    });

    await expect(controller.start()).resolves.toEqual({
      url: "https://host.example/api",
      token: "remote-token",
      mode: "remote",
      managed: false,
    });
    expect(controller.getStatus()).toBe("running");
    expect(statuses).toEqual(["running"]);
  });

  test("uses the development Host for the default managed profile", async () => {
    delete process.env.OPENGUI_BACKEND_MODE;
    delete process.env.OPENGUI_BACKEND_URL;
    delete process.env.OPENGUI_BACKEND_TOKEN;
    delete process.env.OPENGUI_USE_SIDECAR;
    const controller = createBackendSidecarController({
      app: app(),
      settingsStore: { get: () => "malformed profile" },
      isDev: true,
      devServerUrl: "http://127.0.0.1:3001",
    });

    expect(await controller.start()).toEqual({
      url: "http://127.0.0.1:3001",
      token: null,
      mode: "local-managed",
      managed: false,
    });
  });

  test("coalesces concurrent starts and passes deterministic token, cwd, env, and entrypoint", async () => {
    const { controller, spawn } = managedHarness();
    const [first, second] = await Promise.all([controller.start(), controller.start()]);

    expect(first).toEqual(second);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/app/backend.js"],
      expect.objectContaining({
        cwd: "/tmp/opengui-test-user-data/backend",
        env: expect.objectContaining({
          HOST: "127.0.0.1",
          PORT: "43123",
          OPENGUI_AUTH_TOKEN: "fixed-token",
          OPENGUI_ALLOWED_ROOTS: "/home/person",
          OPENGUI_DATA_DIR: "/tmp/opengui-test-user-data/backend",
          OPENGUI_MODE: "desktop-sidecar",
          OPENGUI_SERVER_MODE: "desktop-sidecar",
          ELECTRON_RUN_AS_NODE: "1",
        }),
      }),
    );
  });

  test("coalesces concurrent restarts, reusing the managed port and token", async () => {
    const { controller, spawn, children } = managedHarness();
    const initial = await controller.start();
    const [first, second] = await Promise.all([controller.restart(), controller.restart()]);

    expect(first).toEqual(initial);
    expect(second).toEqual(initial);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
  });

  test("stops a child that is still in its health check", async () => {
    const { controller, children } = managedHarness({
      waitForHealth: (signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    const start = controller.start();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await controller.stop();

    await expect(start).rejects.toThrow("aborted");
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
    expect(controller.getStatus()).toBe("stopped");
  });

  test("kills and reports a failed health startup without retaining stale config", async () => {
    const { controller, children } = managedHarness({
      waitForHealth: async () => {
        throw new Error("health failed");
      },
    });

    await expect(controller.start()).rejects.toThrow("health failed");
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
    expect(controller.getConfig()).toBeNull();
    expect(controller.getStatus()).toBe("crashed");
  });

  test("reports a child crash after a successful start", async () => {
    const statuses: string[] = [];
    const harness = managedHarness();
    const controller = createBackendSidecarController({
      app: app(),
      settingsStore: { get: () => null },
      isDev: false,
      devServerUrl: "http://unused",
      onStatusChange: (status) => statuses.push(status),
      dependencies: {
        spawn: harness.spawn as unknown as typeof spawnProcess,
        findAvailablePort: async () => 43123,
        waitForHealth: async () => {},
        resolveBackendEntrypoint: () => "/app/backend.js",
        randomUUID: () => "fixed-token",
        mkdirSync: vi.fn() as never,
      },
    });
    await controller.start();
    harness.children[0]?.emit("exit", 17, null);

    expect(controller.getStatus()).toBe("crashed");
    expect(controller.getConfig()).toBeNull();
    expect(statuses).toEqual(["starting", "running", "crashed"]);
  });
});

test("managed TypeScript runtime executes as a real Node child process", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengui-sidecar-smoke-"));
  directories.push(root);
  const entrypoint = join(root, "entry.ts");
  await writeFile(entrypoint, 'const value: string = "sidecar-ok"; console.log(value);\n');
  const runtime = resolveManagedRuntime(entrypoint, process.execPath);
  const child = spawnProcess(runtime.command, runtime.args, { env: runtime.env });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  expect({ exitCode, output: output.trim() }).toEqual({ exitCode: 0, output: "sidecar-ok" });
});
