import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { composeFrontendSessionId } from "../../src/lib/session-identity.ts";
import type { StorageService } from "./storage-service.ts";
import { SessionService } from "./session-service.ts";

function stubStorage(): StorageService {
  return {
    listPromptQueue: async () => [],
    createPromptQueueEntry: async () => {
      throw new Error("unused");
    },
    updatePromptQueueEntry: async () => null,
    deletePromptQueueEntry: async () => false,
    deletePromptQueueBySession: async () => [],
    migratePromptQueueSessionId: async () => 0,
    replacePromptQueue: async () => [],
    getSetting: async () => null,
    setSetting: async () => true,
    removeSetting: async () => true,
    getAllSettings: async () => ({}),
    mergeSettings: async () => true,
  };
}

describe("SessionService.resolveSessionId", () => {
  test("maps legacy session_* alias to wire-indexed session", async () => {
    const dir = "/tmp/opengui-resolve-test";
    const wireId = composeFrontendSessionId("pi", "raw-1");
    const legacyPayload = `${dir}::pi::raw-1`;
    const legacyId = `session_${Buffer.from(legacyPayload, "utf8").toString("base64url")}`;

    const service = new SessionService(stubStorage());
    await service.createSession({
      id: wireId,
      rawId: "raw-1",
      directory: dir,
      harnessId: "pi",
      title: "Test",
    });

    const resolved = service.resolveSessionId(legacyId, {
      directory: dir,
      harnessId: "pi",
    });
    expect(resolved).toBe(wireId);
  });

  test("resolves wire id directly when indexed", async () => {
    const dir = "/repo";
    const wireId = composeFrontendSessionId("opencode", "s2");
    const service = new SessionService(stubStorage());
    await service.createSession({
      id: wireId,
      rawId: "s2",
      directory: dir,
      harnessId: "opencode",
    });
    expect(service.resolveSessionId(wireId)).toBe(wireId);
  });
});
