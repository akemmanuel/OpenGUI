import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { App } from "electron";
import { createServer as createHttpServer } from "node:http";
import {
  createBackendSidecarController,
  findAvailablePort,
  loadBackendProfile,
  parseBackendProfile,
  resolveManagedRuntime,
  selectBackendEntrypoint,
  sidecarStartupFailureReason,
  stopOrphanedSidecar,
  waitForHealth,
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
  stderr: EventEmitter | null = null;
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
    withStderr?: boolean;
  } = {},
) {
  process.env.OPENGUI_USE_SIDECAR = "1";
  const children = overrides.children ?? [];
  const stopOrphanedSidecar = vi.fn(async () => false);
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    if (overrides.withStderr) child.stderr = new EventEmitter();
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
      stopOrphanedSidecar,
    },
  });
  return { controller, spawn, children, stopOrphanedSidecar };
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
    const { controller, spawn, stopOrphanedSidecar } = managedHarness();
    const [first, second] = await Promise.all([controller.start(), controller.start()]);

    expect(first).toEqual(second);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(stopOrphanedSidecar).toHaveBeenCalledWith("/tmp/opengui-test-user-data/backend");
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
          OPENGUI_EXIT_WITH_STDIN: "1",
          ELECTRON_RUN_AS_NODE: "1",
        }),
        stdio: ["pipe", "pipe", "pipe"],
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

  test("explains a startup exit with the reason the sidecar logged", async () => {
    const { controller, children } = managedHarness({
      withStderr: true,
      waitForHealth: () => new Promise(() => {}),
    });
    const start = controller.start();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const child = children[0]!;
    child.stderr?.emit(
      "data",
      "OpenGUI Host failed to start: Durable state is already in use by pid 42\n",
    );
    child.exitCode = 1;
    child.emit("exit", 1, null);

    await expect(start).rejects.toThrow(
      "Backend sidecar exited before becoming healthy (1): Durable state is already in use by pid 42",
    );
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
        stopOrphanedSidecar: async () => false,
      },
    });
    await controller.start();
    harness.children[0]?.emit("exit", 17, null);

    expect(controller.getStatus()).toBe("crashed");
    expect(controller.getConfig()).toBeNull();
    expect(statuses).toEqual(["starting", "running", "crashed"]);
  });
});

describe("sidecar startup diagnostics", () => {
  test("prefers the Host failure line and falls back to the last stderr line", () => {
    expect(
      sidecarStartupFailureReason(
        "OpenGUI Host failed to start: Durable state is already in use\n{ _tag: 'X' }\n",
      ),
    ).toBe("Durable state is already in use");
    expect(sidecarStartupFailureReason("warning\nError: listen EADDRINUSE\n\n")).toBe(
      "Error: listen EADDRINUSE",
    );
    expect(sidecarStartupFailureReason("")).toBeNull();
  });
});

describe("orphaned sidecar cleanup", () => {
  function orphan(options: { lock?: string | null; command?: string | null; diesAfter?: number }) {
    let checks = 0;
    let clock = 0;
    const kill = vi.fn();
    const dependencies = {
      readLock: vi.fn(() =>
        options.lock === undefined ? JSON.stringify({ pid: 4242 }) : options.lock,
      ),
      isAlive: vi.fn(() => {
        checks += 1;
        return checks <= (options.diesAfter ?? 2);
      }),
      commandLine: vi.fn(() =>
        options.command === undefined
          ? "/Applications/OpenGUI.app/Contents/MacOS/OpenGUI /app.asar.unpacked/dist-electron/backend.js"
          : options.command,
      ),
      kill,
      sleep: vi.fn(async () => {
        clock += 1_000;
      }),
      now: () => clock,
    };
    return { dependencies, kill };
  }

  test("stops a live sidecar that still holds the Host state lock", async () => {
    const { dependencies, kill } = orphan({});
    await expect(stopOrphanedSidecar("/data", dependencies)).resolves.toBe(true);
    expect(dependencies.readLock).toHaveBeenCalledWith(
      join("/data", "opengui-host-state.json.lock"),
    );
    expect(kill.mock.calls).toEqual([[4242, "SIGTERM"]]);
  });

  test("kills an orphan that ignores SIGTERM", async () => {
    const { dependencies, kill } = orphan({ diesAfter: Number.POSITIVE_INFINITY });
    await expect(stopOrphanedSidecar("/data", dependencies)).resolves.toBe(true);
    expect(kill.mock.calls).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGKILL"],
    ]);
  });

  test.each([
    ["no lock", { lock: null }],
    ["a malformed lock", { lock: "{" }],
    ["a dead holder", { diesAfter: 0 }],
    ["a reused PID", { command: "/usr/bin/vim notes.txt" }],
    ["an unreadable command line", { command: null }],
  ])("leaves %s alone", async (_label, options) => {
    const { dependencies, kill } = orphan(options);
    await expect(stopOrphanedSidecar("/data", dependencies)).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  test("never stops the current process", async () => {
    const { dependencies, kill } = orphan({ lock: JSON.stringify({ pid: process.pid }) });
    await expect(stopOrphanedSidecar("/data", dependencies)).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
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

describe("sidecar health and port helpers", () => {
  async function healthServer(failures: number) {
    let requests = 0;
    const server = createHttpServer((request, response) => {
      requests += 1;
      response.statusCode = requests > failures ? 200 : 503;
      response.end(request.headers.authorization ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}`,
      requests: () => requests,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  test("allocates a free loopback port", async () => {
    const port = await findAvailablePort();
    expect(port).toBeGreaterThan(0);
  });

  test("polls until the backend reports healthy", async () => {
    const server = await healthServer(2);
    try {
      await waitForHealth(server.url, "token", 5_000);
      expect(server.requests()).toBe(3);
    } finally {
      await server.close();
    }
  });

  test("times out when the backend never becomes healthy", async () => {
    const server = await healthServer(Number.POSITIVE_INFINITY);
    try {
      await expect(waitForHealth(server.url, null, 600)).rejects.toThrow(/Timed out waiting/);
    } finally {
      await server.close();
    }
  });

  test("stops polling when aborted", async () => {
    const server = await healthServer(Number.POSITIVE_INFINITY);
    const controller = new AbortController();
    try {
      const pending = waitForHealth(server.url, null, 30_000, controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});
