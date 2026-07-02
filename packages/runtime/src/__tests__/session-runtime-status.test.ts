import { describe, expect, test } from "vite-plus/test";
import { sessionStatusKey, updateSessionStatusMap } from "../session-runtime-status.ts";

describe("updateSessionStatusMap", () => {
  test("updates idle across registered directory without directory on event", () => {
    const map = new Map<string, "idle" | "running" | "error" | "unknown">();
    const directory = "/tmp/project";
    const harnessId = "pi" as const;
    const rawId = "s1";
    map.set(sessionStatusKey(directory, harnessId, rawId), "running");

    updateSessionStatusMap({
      map,
      harnessId,
      rawId,
      status: "idle",
      registeredDirectories: new Set([directory]),
    });

    expect(map.get(sessionStatusKey(directory, harnessId, rawId))).toBe("idle");
  });

  test("updates all directories that already track the session", () => {
    const map = new Map<string, "idle" | "running" | "error" | "unknown">();
    const harnessId = "pi" as const;
    const rawId = "s1";
    map.set(sessionStatusKey("/a", harnessId, rawId), "running");
    map.set(sessionStatusKey("/b", harnessId, rawId), "running");

    updateSessionStatusMap({
      map,
      harnessId,
      rawId,
      status: "idle",
      registeredDirectories: new Set(),
    });

    expect(map.get(sessionStatusKey("/a", harnessId, rawId))).toBe("idle");
    expect(map.get(sessionStatusKey("/b", harnessId, rawId))).toBe("idle");
  });
});
