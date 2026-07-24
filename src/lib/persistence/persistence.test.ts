import { afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { STORAGE_KEYS } from "@/lib/constants";
import { polyfillLocalStorage } from "@/lib/__tests__/setup";
import { getProjectMetaMap, persistProjectMetaMap } from "./project";
import { getSessionMetaMap, persistSessionMetaMap } from "./session";
import {
  getActiveWorkspace,
  getStoredWorkspaces,
  initializeBackendWorkspaceState,
  LOCAL_WORKSPACE_ID,
  normalizeWorkspace,
  persistWorkspaces,
} from "./workspace";
import type { Workspace } from "@/types/workspace";

beforeAll(() => polyfillLocalStorage());
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

function shell(kind: "desktop" | "mobile" | "web") {
  vi.stubGlobal("navigator", {
    userAgent: kind === "desktop" ? "OpenGUI Electron/43.0" : "Mozilla/5.0",
  });
  vi.stubGlobal("window", {
    location: { origin: "https://host.example" },
    Capacitor: { isNativePlatform: () => kind === "mobile" },
    __OPENGUI_CONFIG__: {},
    dispatchEvent: vi.fn(() => true),
  });
}

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    serverUrl: `https://${id}.example`,
    isLocal: id === LOCAL_WORKSPACE_ID,
    projects: [],
    ...overrides,
  };
}

describe("session persistence", () => {
  test("prunes empty metadata while preserving explicit null selections", () => {
    persistSessionMetaMap({
      empty: {},
      inherited: { selectedModel: null },
      tagged: { tags: ["important"] },
    });

    expect(getSessionMetaMap()).toEqual({
      inherited: { selectedModel: null },
      tagged: { tags: ["important"] },
    });
  });

  test("removes the established key when no metadata remains", () => {
    localStorage.setItem(STORAGE_KEYS.SESSION_META, "stale");
    persistSessionMetaMap({ session: {} });
    expect(localStorage.getItem(STORAGE_KEYS.SESSION_META)).toBeNull();
  });
});

describe("project persistence", () => {
  test("keeps pinned and hidden metadata under the established key", () => {
    persistProjectMetaMap({
      empty: {},
      pinned: { pinnedAt: "2025-01-01T00:00:00.000Z" },
      hidden: { hidden: true },
    });

    expect(getProjectMetaMap()).toEqual({
      pinned: { pinnedAt: "2025-01-01T00:00:00.000Z" },
      hidden: { hidden: true },
    });
    expect(localStorage.getItem(STORAGE_KEYS.PROJECT_META)).not.toBeNull();
  });
});

describe("active Workspace persistence", () => {
  test("resolves the persisted active Workspace instead of the first row", () => {
    const workspace = (id: string, name: string): Workspace => ({
      id,
      name,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      settings: { serverUrl: `https://${id}.example` },
      serverUrl: `https://${id}.example`,
      isLocal: false,
      projects: [],
      selectedModel: null,
      selectedAgent: null,
      lastActiveSessionId: null,
    });
    const first = workspace("first", "First");
    const active = workspace("active", "Active");
    localStorage.setItem(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, active.id);

    expect(getActiveWorkspace([first, active])).toEqual(active);
  });

  test("normalizes legacy settings without treating a username password as a Host token", () => {
    const normalized = normalizeWorkspace(
      workspace("remote", {
        name: "  ",
        serverUrl: "host.example/path",
        projects: ["/work/project/", "/work/project"],
        settings: {
          username: "builder",
          password: "account-password",
          defaultChatDirectory: "/work/default/",
          selectedAgent: "agent-a",
        },
      }),
    );

    expect(normalized).toMatchObject({
      name: "Workspace",
      serverUrl: "https://host.example/path",
      projects: ["/work/project"],
      authToken: undefined,
      selectedAgent: "agent-a",
      settings: {
        username: "builder",
        password: "account-password",
        authToken: undefined,
        defaultChatDirectory: "/work/default",
      },
    });
  });

  test("migrates the Desktop default directory into the active local Workspace once", async () => {
    shell("desktop");
    localStorage.setItem(
      STORAGE_KEYS.WORKSPACES,
      JSON.stringify([workspace(LOCAL_WORKSPACE_ID, { settings: {} })]),
    );
    localStorage.setItem(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, LOCAL_WORKSPACE_ID);
    localStorage.setItem(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY, "/work/default/");

    const [first, concurrent] = await Promise.all([
      initializeBackendWorkspaceState(),
      initializeBackendWorkspaceState(),
    ]);

    expect(first).toEqual(concurrent);
    expect(first[0]?.settings?.defaultChatDirectory).toBe("/work/default");
    expect(localStorage.getItem("opengui:workspaceMigrationV1")).toBe("done");
  });

  test("persists only remote Workspaces on mobile", () => {
    shell("mobile");
    persistWorkspaces([workspace(LOCAL_WORKSPACE_ID), workspace("remote")]);

    expect(getStoredWorkspaces().map(({ id }) => id)).toEqual(["remote"]);
  });
});
