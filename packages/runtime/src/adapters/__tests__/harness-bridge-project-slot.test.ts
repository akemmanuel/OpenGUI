import { describe, expect, test } from "vite-plus/test";
import {
  createHarnessProjectSlot,
  ensureHarnessProjectSlot,
  resolveHarnessProjectKey,
} from "../harness-bridge-project-slot.ts";

describe("harness-bridge-project-slot", () => {
  test("resolveHarnessProjectKey normalizes directory", () => {
    const resolved = resolveHarnessProjectKey({ directory: "  /repo  ", workspaceId: "w1" });
    expect(resolved.directory).toBe("/repo");
    expect(resolved.key).toContain("w1");
    expect(resolved.key).toContain("/repo");
  });

  test("ensureHarnessProjectSlot creates once per key", () => {
    const projects = new Map<string, ReturnType<typeof createHarnessProjectSlot>>();
    const a = ensureHarnessProjectSlot(projects, { directory: "/a" }, createHarnessProjectSlot);
    const b = ensureHarnessProjectSlot(projects, { directory: "/a" }, createHarnessProjectSlot);
    expect(a).toBe(b);
    expect(projects.size).toBe(1);
  });

  test("throws when directory missing", () => {
    expect(() => resolveHarnessProjectKey({})).toThrow(/directory/i);
  });
});
