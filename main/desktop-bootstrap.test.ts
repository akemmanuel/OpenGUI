import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vite-plus/test";
import { bootstrapDesktopApp } from "./desktop-bootstrap";

class FakeApp extends EventEmitter {
  quit = vi.fn();
  requestSingleInstanceLock = vi.fn(() => true);
  whenReady = vi.fn(async () => undefined);
}

function harness(options: { lock?: boolean; platform?: NodeJS.Platform } = {}) {
  const app = new FakeApp();
  app.requestSingleInstanceLock.mockReturnValue(options.lock ?? true);
  const windows: Array<{
    isMinimized: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  }> = [];
  const backend = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
  const createWindow = vi.fn(() => {
    const win = { isMinimized: vi.fn(() => false), restore: vi.fn(), focus: vi.fn() };
    windows.push(win);
    return win;
  });
  const ready = bootstrapDesktopApp({
    app: app as never,
    platform: options.platform ?? "linux",
    backend,
    createWindow,
    getAllWindows: () => windows as never,
    installReadyIntegrations: vi.fn(),
    showStartupError: vi.fn(),
    reportShutdownError: vi.fn(),
  });
  return { app, backend, createWindow, windows, ready };
}

describe("Desktop application bootstrap", () => {
  test("a secondary instance exits before starting the Host or creating windows", async () => {
    const { app, backend, createWindow, ready } = harness({ lock: false });
    await ready;
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(backend.start).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });

  test("starts the Host after app readiness and only then creates the first window", async () => {
    const calls: string[] = [];
    const app = new FakeApp();
    app.whenReady = vi.fn(async () => void calls.push("ready"));
    const ready = bootstrapDesktopApp({
      app: app as never,
      platform: "linux",
      backend: {
        start: vi.fn(async () => void calls.push("host")),
        stop: vi.fn(async () => undefined),
      },
      createWindow: vi.fn(() => void calls.push("window")),
      getAllWindows: () => [],
      installReadyIntegrations: () => calls.push("integrations"),
      showStartupError: vi.fn(),
      reportShutdownError: vi.fn(),
    });
    await ready;
    expect(calls).toEqual(["ready", "integrations", "host", "window"]);
  });

  test("focuses and restores the existing window for a second instance", async () => {
    const { app, windows, ready } = harness();
    await ready;
    windows[0]?.isMinimized.mockReturnValue(true);
    app.emit("second-instance");
    await Promise.resolve();
    expect(windows[0]?.restore).toHaveBeenCalledOnce();
    expect(windows[0]?.focus).toHaveBeenCalledOnce();
  });

  test("recreates a window on activation and second launch when none remain", async () => {
    const { app, createWindow, windows, ready } = harness({ platform: "darwin" });
    await ready;
    windows.length = 0;
    app.emit("activate");
    windows.length = 0;
    app.emit("second-instance");
    await Promise.resolve();
    expect(createWindow).toHaveBeenCalledTimes(3);
  });

  test.each([
    ["darwin", false],
    ["linux", true],
    ["win32", true],
  ] as const)("applies window-all-closed behavior on %s", async (platform, quits) => {
    const { app, ready } = harness({ platform });
    await ready;
    app.emit("window-all-closed");
    expect(app.quit).toHaveBeenCalledTimes(quits ? 1 : 0);
  });
});
