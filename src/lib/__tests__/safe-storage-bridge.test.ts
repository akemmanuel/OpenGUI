import { beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { SettingsBridge, SettingsBridgeChange } from "@/types/settings";
import { polyfillLocalStorage } from "./setup";

let changeListener: ((change: SettingsBridgeChange) => void) | undefined;
const set = vi.fn(async () => true);
const remove = vi.fn(async () => true);
const bridge = {
  getAllSync: () => ({ existing: "from-bridge" }),
  onDidChange: (listener: (change: SettingsBridgeChange) => void) => {
    changeListener = listener;
    return () => {};
  },
  set,
  remove,
} as unknown as SettingsBridge;

vi.mock("@/runtime/settings", () => ({ getSettingsBridge: () => bridge }));

describe("settings bridge mirroring", () => {
  beforeAll(() => polyfillLocalStorage());

  test("hydrates, writes, removes, and receives changes through one mirror", async () => {
    const { storageGet, storageRemove, storageSet } = await import("../persistence/storage");

    expect(storageGet("existing")).toBe("from-bridge");
    expect(localStorage.getItem("existing")).toBe("from-bridge");

    storageSet("added", "value");
    expect(localStorage.getItem("added")).toBe("value");
    expect(set).toHaveBeenCalledWith("added", "value");

    storageRemove("added");
    expect(localStorage.getItem("added")).toBeNull();
    expect(remove).toHaveBeenCalledWith("added");

    changeListener?.({ key: "remote", value: "change" });
    expect(storageGet("remote")).toBe("change");
    expect(localStorage.getItem("remote")).toBe("change");
    changeListener?.({ key: "remote", value: null });
    expect(storageGet("remote")).toBeNull();
    expect(localStorage.getItem("remote")).toBeNull();
  });
});
