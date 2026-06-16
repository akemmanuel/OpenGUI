import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  harnessSessionIdentity,
  composeFrontendSessionId,
  harnessRawSessionKey,
  parseFrontendSessionId,
  rawSessionIdForHarness,
  sameHarnessSessionIdentity,
  scopedRawSessionKey,
} from "@/lib/session-identity";

describe("session identity", () => {
  test("composes and parses frontend Session IDs", () => {
    expect(composeFrontendSessionId("opencode", "raw-1")).toBe("opencode:raw-1");
    expect(composeFrontendSessionId("opencode", "opencode:raw-1")).toBe("opencode:raw-1");
    expect(() => composeFrontendSessionId("opencode", "")).toThrow(/missing raw session id/);
    expect(parseFrontendSessionId("pi:native-1")).toEqual({ harnessId: "pi", rawId: "native-1" });
    expect(parseFrontendSessionId("session_canonical")).toBeNull();
  });

  test("extracts raw Session IDs only for the matching Harness", () => {
    expect(rawSessionIdForHarness("codex:abc", "codex")).toBe("abc");
    expect(rawSessionIdForHarness("codex:abc", "pi")).toBe("codex:abc");
  });

  test("compares the same backend Session across frontend shapes", () => {
    expect(
      sameHarnessSessionIdentity(
        { id: "opencode:raw-1" },
        { id: "anything", _harnessId: "opencode", _rawId: "raw-1" },
      ),
    ).toBe(true);
    expect(harnessSessionIdentity({ id: "anything", _harnessId: "pi", _rawId: "raw-1" })).toBe(
      "pi:raw-1",
    );
  });

  test("keeps legacy backend-tagged Sessions identifiable after Harness migration", () => {
    expect(harnessSessionIdentity({ id: "raw-1", _backendId: "opencode" })).toBe("opencode:raw-1");
    expect(
      sameHarnessSessionIdentity({ id: "raw-1", _backendId: "opencode" }, { id: "opencode:raw-1" }),
    ).toBe(true);
  });

  test("builds storage mapping keys in one place", () => {
    expect(scopedRawSessionKey({ projectId: "project-1", harnessId: "pi", rawId: "raw-1" })).toBe(
      "project-1::pi::raw-1",
    );
    expect(harnessRawSessionKey("pi", "raw-1")).toBe("pi::raw-1");
  });
});
