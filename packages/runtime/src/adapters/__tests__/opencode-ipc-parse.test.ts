import { describe, expect, test } from "vite-plus/test";
import {
  parseDaemonEvent,
  parseOpenCodeHealthJson,
  parsePermissionResponse,
} from "../opencode-ipc-parse.ts";

describe("opencode-ipc-parse", () => {
  describe("parsePermissionResponse", () => {
    test("accepts literal permission strings", () => {
      expect(parsePermissionResponse("always")).toBe("always");
      expect(parsePermissionResponse("once")).toBe("once");
      expect(parsePermissionResponse("reject")).toBe("reject");
    });

    test("reads response or reply from object", () => {
      expect(parsePermissionResponse({ response: "once" })).toBe("once");
      expect(parsePermissionResponse({ reply: "reject" })).toBe("reject");
    });

    test("returns null for invalid values", () => {
      expect(parsePermissionResponse(null)).toBeNull();
      expect(parsePermissionResponse({ response: "maybe" })).toBeNull();
      expect(parsePermissionResponse(1)).toBeNull();
    });
  });

  describe("parseOpenCodeHealthJson", () => {
    test("returns unhealthy snapshot for non-record", () => {
      expect(parseOpenCodeHealthJson(null)).toEqual({ healthy: false, version: null });
      expect(parseOpenCodeHealthJson("bad")).toEqual({ healthy: false, version: null });
    });

    test("parses healthy flag and version string", () => {
      expect(parseOpenCodeHealthJson({ healthy: true, version: "1.2.3" })).toEqual({
        healthy: true,
        version: "1.2.3",
      });
      expect(parseOpenCodeHealthJson({ healthy: false, version: 9 })).toEqual({
        healthy: false,
        version: null,
      });
    });
  });

  describe("parseDaemonEvent", () => {
    test("parses JSON string bodies", () => {
      expect(parseDaemonEvent('{"type":"ping","n":1}')).toEqual({ type: "ping", n: 1 });
    });

    test("returns null for empty or invalid JSON strings", () => {
      expect(parseDaemonEvent("")).toBeNull();
      expect(parseDaemonEvent("not-json")).toBeNull();
    });

    test("accepts already-parsed record objects", () => {
      const obj = { event: "session", id: "x" };
      expect(parseDaemonEvent(obj)).toBe(obj);
    });

    test("rejects arrays and primitives", () => {
      expect(parseDaemonEvent([])).toBeNull();
      expect(parseDaemonEvent(42)).toBeNull();
    });
  });
});
