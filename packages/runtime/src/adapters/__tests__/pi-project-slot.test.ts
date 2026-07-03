import { describe, expect, test } from "vite-plus/test";
import {
  createEmptyPiProjectShell,
  registerPiBridgeProjectForTests,
  resolvePiProjectKeyFromTarget,
} from "../pi-project-slot.ts";

describe("pi-project-slot", () => {
  test("resolvePiProjectKeyFromTarget normalizes directory", () => {
    const { key, directory } = resolvePiProjectKeyFromTarget({ directory: "/repo/" });
    expect(directory.replace(/\/+$/, "")).toBe("/repo");
    expect(key).toContain("/repo");
  });

  test("createEmptyPiProjectShell has runtime maps", () => {
    const shell = createEmptyPiProjectShell("k", "/repo", "w");
    expect(shell.sessionCaches.size).toBe(0);
    expect(shell.busySessionIds.size).toBe(0);
    expect(shell.directory).toBe("/repo");
  });

  test("registerPiBridgeProjectForTests inserts shell into manager registry", () => {
    const registry = { projects: new Map() };
    const project = registerPiBridgeProjectForTests(registry, { directory: "/repo" });
    expect(registry.projects.get(project.key)).toBe(project);
    expect(project.directory).toBe("/repo");
  });
});
