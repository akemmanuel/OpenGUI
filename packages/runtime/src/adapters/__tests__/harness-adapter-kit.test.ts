import { describe, expect, test } from "vite-plus/test";
import {
  fail,
  makeHarnessProjectKey,
  makeHarnessSessionIdCodec,
  normalizeHarnessDirectory,
  ok,
} from "../harness-adapter-kit.ts";

describe("harness-adapter-kit", () => {
  test("normalizeHarnessDirectory trims and normalizes", () => {
    expect(normalizeHarnessDirectory("  /foo/bar  ")).toBeTruthy();
    expect(normalizeHarnessDirectory("")).toBe("");
    expect(normalizeHarnessDirectory(42)).toBe("");
  });

  test("makeHarnessProjectKey scopes workspace", () => {
    const key = makeHarnessProjectKey("ws-1", "/repo");
    expect(key).toContain("ws-1");
    expect(makeHarnessProjectKey(undefined, "/repo")).toContain("local");
  });

  test("makeHarnessSessionIdCodec round-trips pi prefix", () => {
    const { toFrontendSessionId, toRawSessionId } = makeHarnessSessionIdCodec("pi:");
    expect(toFrontendSessionId("abc")).toBe("pi:abc");
    expect(toRawSessionId("pi:abc")).toBe("abc");
    expect(toRawSessionId("abc")).toBe("abc");
  });

  test("ok and fail helpers", () => {
    expect(ok(1)).toEqual({ success: true, data: 1 });
    expect(fail(new Error("x"))).toEqual({ success: false, error: "x" });
  });
});
