import { afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import { STORAGE_KEYS } from "@/lib/constants";
import { polyfillLocalStorage } from "@/lib/__tests__/setup";
import { getProjectMetaMap, persistProjectMetaMap } from "./project";
import { getSessionMetaMap, persistSessionMetaMap } from "./session";
import { getActiveWorkspace } from "./workspace";
import type { Workspace } from "@/types/workspace";

beforeAll(() => polyfillLocalStorage());
afterEach(() => localStorage.clear());

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
});
