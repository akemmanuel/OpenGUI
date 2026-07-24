import { describe, expect, test, vi } from "vite-plus/test";
import { createElectronAPI, type PreloadIpc } from "./preload-api";

function harness(config: unknown = {}) {
  const listeners = new Map<string, Set<(event: unknown, data: never) => void>>();
  const sendSync = vi.fn((channel: string) => {
    if (channel === "backend:get-config-sync") return config;
    if (channel === "settings:get-all-sync") return { theme: "dark" };
    return null;
  });
  const invoke = vi.fn(async () => true);
  const ipc: PreloadIpc = {
    sendSync,
    invoke,
    on(channel, listener) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
  };
  const api = createElectronAPI({
    ipc,
    locationSearch: "?detach=%2Fprojects%2Fdemo",
    currentVersion: "9.8.7",
  });
  const emit = (channel: string, value: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener({}, value as never);
  };
  return { api, sendSync, invoke, listeners, emit };
}

describe("Desktop preload API contract", () => {
  test("exposes the complete stable Desktop Shell surface", () => {
    const { api } = harness();
    expect(Object.keys(api).sort()).toEqual(
      [
        "backendFetch",
        "backendStatus",
        "backendToken",
        "backendUrl",
        "close",
        "detachProject",
        "focus",
        "getDetachedProject",
        "getDetachedProjects",
        "getHomeDir",
        "getPlatform",
        "getSystemLocale",
        "isMaximized",
        "isPackaged",
        "kind",
        "maximize",
        "minimize",
        "onBackendStatusChange",
        "onDetachedProjectsChange",
        "onMaximizeChange",
        "openDirectory",
        "openExternal",
        "openInFileBrowser",
        "openInTerminal",
        "restartBackend",
        "settings",
        "subscribeBackendEvents",
        "updates",
      ].sort(),
    );
    expect(Object.keys(api.settings).sort()).toEqual(
      [
        "getAllSync",
        "getSync",
        "mergeSync",
        "onDidChange",
        "remove",
        "removeSync",
        "set",
        "setSync",
      ].sort(),
    );
    expect(Object.keys(api.updates).sort()).toEqual(
      ["check", "download", "getState", "install", "isManaged", "onStateChanged"].sort(),
    );
  });

  test("projects the synchronous backend config and safe defaults", () => {
    expect(harness({ url: "ignored" }).api).toMatchObject({
      kind: "electron",
      backendUrl: null,
      backendToken: null,
      backendStatus: "stopped",
    });
    expect(
      harness({
        kind: "electron",
        backendUrl: "http://127.0.0.1:42",
        backendToken: "secret",
        backendStatus: "running",
      }).api,
    ).toMatchObject({
      backendUrl: "http://127.0.0.1:42",
      backendToken: "secret",
      backendStatus: "running",
    });
  });

  test("maps settings and window calls to their stable IPC channels", async () => {
    const { api, sendSync, invoke } = harness();
    expect(api.settings.getAllSync()).toEqual({ theme: "dark" });
    api.settings.setSync("theme", "light");
    await api.maximize();
    await api.openInTerminal("/project", "ghostty");

    expect(sendSync).toHaveBeenCalledWith("settings:set-sync", "theme", "light");
    expect(invoke).toHaveBeenCalledWith("window:maximize");
    expect(invoke).toHaveBeenCalledWith("shell:openInTerminal", "/project", "ghostty");
    expect(api.getDetachedProject()).toBe("/projects/demo");
  });

  test("listener disposers remove exactly the registered bridge callback", () => {
    const { api, listeners, emit } = harness();
    const observed: boolean[] = [];
    const dispose = api.onMaximizeChange((value) => observed.push(value));
    expect(listeners.get("window:maximizeChanged")?.size).toBe(1);
    emit("window:maximizeChanged", true);
    dispose();
    emit("window:maximizeChanged", false);

    expect(observed).toEqual([true]);
    expect(listeners.get("window:maximizeChanged")?.size).toBe(0);
  });

  test("backend event subscription starts and stops both IPC directions", async () => {
    const { api, invoke, emit } = harness();
    const observed: unknown[] = [];
    const dispose = api.subscribeBackendEvents?.((message) => observed.push(message));
    emit("backend:event", { channel: "session", data: 1 });
    dispose?.();
    await Promise.resolve();

    expect(observed).toEqual([{ channel: "session", data: 1 }]);
    expect(invoke).toHaveBeenCalledWith("backend:events-subscribe");
    expect(invoke).toHaveBeenCalledWith("backend:events-unsubscribe");
  });

  test("exposes managed updates through isolated IPC calls and events", async () => {
    const { api, invoke, listeners } = harness();
    expect(api.updates.isManaged).toBe(true);
    await api.updates.getState();
    await api.updates.check();
    await api.updates.download();
    await api.updates.install();
    const dispose = api.updates.onStateChanged(() => {});
    expect(invoke.mock.calls).toEqual([
      ["update:get-state"],
      ["update:check"],
      ["update:download"],
      ["update:install"],
    ]);
    expect(listeners.get("update:state-changed")?.size).toBe(1);
    dispose();
  });
});
