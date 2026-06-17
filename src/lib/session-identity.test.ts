import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  composeFrontendSessionId,
  decodeCanonicalDirectorySessionId,
  resolveWireSessionIdentity,
} from "./session-identity.ts";

describe("resolveWireSessionIdentity", () => {
  test("parses wire id pi:raw", () => {
    const result = resolveWireSessionIdentity("pi:abc-123");
    expect(result).toEqual({
      harnessId: "pi",
      rawId: "abc-123",
      wireId: "pi:abc-123",
    });
  });

  test("parses legacy session_* index id", () => {
    const legacyId = Buffer.from("/repo::pi::raw-legacy", "utf8").toString("base64url");
    const sessionId = `session_${legacyId}`;
    const result = resolveWireSessionIdentity(sessionId);
    expect(result).toEqual({
      harnessId: "pi",
      rawId: "raw-legacy",
      wireId: "pi:raw-legacy",
    });
  });

  test("resolves bare raw id with scope harness", () => {
    const result = resolveWireSessionIdentity("only-raw", "codex");
    expect(result).toEqual({
      harnessId: "codex",
      rawId: "only-raw",
      wireId: "codex:only-raw",
    });
  });

  test("returns null for unknown id without scope harness", () => {
    expect(resolveWireSessionIdentity("mystery-id")).toBeNull();
  });
});

describe("decodeCanonicalDirectorySessionId", () => {
  test("round-trips with composeFrontendSessionId", () => {
    const wire = composeFrontendSessionId("opencode", "sess-1");
    expect(wire).toBe("opencode:sess-1");
    const legacyPayload = "/path::opencode::sess-1";
    const legacy = `session_${Buffer.from(legacyPayload, "utf8").toString("base64url")}`;
    expect(decodeCanonicalDirectorySessionId(legacy)).toMatchObject({
      directory: "/path",
      harnessId: "opencode",
      rawId: "sess-1",
    });
  });
});
