import { describe, expect, test } from "vite-plus/test";
import { homedir } from "node:os";
import { createOpenGUI, MANAGED_HARNESS_IDS } from "../index.ts";
import { joinTmpRuntimeDir } from "./test-helpers.ts";

describe("createOpenGUI", () => {
  test("rejects empty allowedRoots", async () => {
    await expect(createOpenGUI({ allowedRoots: ["  ", ""] })).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
  });

  test("constructs runtime with managed harness handles", async () => {
    const home = homedir();
    const og = await createOpenGUI({
      dataDir: joinTmpRuntimeDir(),
      allowedRoots: [home],
    });
    try {
      expect(MANAGED_HARNESS_IDS).toContain("pi");
      const dir = await og.at(home);
      const pi = dir.harness("pi");
      expect(pi.harnessId).toBe("pi");
      expect(pi.directoryPath).toBe(home);
      expect(typeof pi.on).toBe("function");
      expect(typeof pi.sessions.list).toBe("function");
      const inventories = og.getHarnessInventories();
      expect(inventories.some((row) => row.harnessId === "pi")).toBe(true);
      const diag = og.diagnose();
      expect(diag.harnesses.length).toBeGreaterThan(0);
    } finally {
      await og.close();
    }
  }, 60_000);
});

describe("og.at", () => {
  test("rejects directory outside allowedRoots", async () => {
    const home = homedir();
    const og = await createOpenGUI({
      dataDir: joinTmpRuntimeDir(),
      allowedRoots: [home],
    });
    try {
      await expect(og.at("/nonexistent-opengui-sdk-root-xyz")).rejects.toThrow();
    } finally {
      await og.close();
    }
  });

  test("at() resolves canonical path and bound harness omits directory on list", async () => {
    const home = homedir();
    const og = await createOpenGUI({
      dataDir: joinTmpRuntimeDir(),
      allowedRoots: [home],
    });
    try {
      const dir = await og.at(home);
      expect(dir.path).toBe(home);
      const pi = dir.harness("pi");
      expect(pi.directoryPath).toBe(home);
      await dir.connect({ harnesses: ["pi"] });
      const sessions = await pi.sessions.list();
      expect(Array.isArray(sessions)).toBe(true);
      await dir.connect({ harnesses: ["pi"] });
    } finally {
      await og.close();
    }
  }, 60_000);

  test("bound harness prompt requires directory when not from at()", async () => {
    const home = homedir();
    const og = await createOpenGUI({
      dataDir: joinTmpRuntimeDir(),
      allowedRoots: [home],
    });
    try {
      const pi = og.harness("pi");
      expect(pi.directoryPath).toBeUndefined();
      await expect(pi.sessions.list()).rejects.toMatchObject({ code: "DIRECTORY_REQUIRED" });
    } finally {
      await og.close();
    }
  }, 60_000);

  test('createOpenGUI({ harnesses: ["pi"] }) loads only pi adapter', async () => {
    const home = homedir();
    const og = await createOpenGUI({
      dataDir: joinTmpRuntimeDir(),
      allowedRoots: [home],
      harnesses: ["pi"],
    });
    try {
      const dir = await og.at(home);
      expect(dir.harness("pi").harnessId).toBe("pi");
      expect(() => dir.harness("opencode")).toThrow(/unloaded|opencode/i);
    } finally {
      await og.close();
    }
  }, 60_000);
});

describe("SessionHandle (integration)", () => {
  test("sessions.create returns handle with id and send/abort/messages", async () => {
    const home = homedir();
    const og = await createOpenGUI({
      dataDir: joinTmpRuntimeDir(),
      allowedRoots: [home],
    });
    try {
      const dir = await og.at(home);
      await dir.connect({ harnesses: ["pi"] });
      const pi = dir.harness("pi");
      const session = await pi.sessions.create({ title: "sdk-phase-b" });
      expect(typeof session.id).toBe("string");
      expect(session.id.length).toBeGreaterThan(0);
      expect(session.harnessId).toBe("pi");
      expect(session.directory).toBe(home);
      expect(typeof session.send).toBe("function");
      expect(typeof session.abort).toBe("function");
      expect(typeof session.messages).toBe("function");
      expect(typeof session.onStream).toBe("function");
      expect(typeof session.waitUntilIdle).toBe("function");
      session.close();
    } finally {
      await og.close();
    }
  }, 90_000);

  test("sessions.open wraps id from list", async () => {
    const home = homedir();
    const og = await createOpenGUI({
      dataDir: joinTmpRuntimeDir(),
      allowedRoots: [home],
    });
    try {
      const dir = await og.at(home);
      await dir.connect({ harnesses: ["pi"] });
      const pi = dir.harness("pi");
      const created = await pi.sessions.create();
      const reopened = await pi.sessions.open(created.id);
      expect(reopened.id).toBe(created.id);
      const listed = await pi.sessions.list();
      expect(Array.isArray(listed)).toBe(true);
    } finally {
      await og.close();
    }
  }, 90_000);
});
