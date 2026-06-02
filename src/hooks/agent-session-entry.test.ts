import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { decideSessionEntry } from "./agent-session-entry";

describe("decideSessionEntry", () => {
  test("uses the active session when one exists", () => {
    expect(decideSessionEntry({ activeSessionId: "session-1" })).toEqual({
      type: "use-active-session",
      sessionId: "session-1",
    });
  });

  test("returns missing-session when no active session exists", () => {
    expect(decideSessionEntry({ activeSessionId: null })).toEqual({ type: "missing-session" });
  });
});
