import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { decideSessionEntry } from "./agent-session-entry";

describe("decideSessionEntry", () => {
  test("uses the active session when one exists", () => {
    expect(
      decideSessionEntry({
        activeSessionId: "session-1",
        draftDirectory: "/repo",
        canStartSession: true,
      }),
    ).toEqual({ type: "use-active-session", sessionId: "session-1" });
  });

  test("starts a draft session when no active session exists and startSession is available", () => {
    expect(
      decideSessionEntry({
        activeSessionId: null,
        draftDirectory: "/repo",
        canStartSession: true,
      }),
    ).toEqual({ type: "start-draft-session", directory: "/repo" });
  });

  test("creates a session from draft when no active session exists and startSession is unavailable", () => {
    expect(
      decideSessionEntry({
        activeSessionId: null,
        draftDirectory: "/repo",
        canStartSession: false,
      }),
    ).toEqual({ type: "create-session-from-draft", directory: "/repo" });
  });

  test("returns missing-session when nothing can be used", () => {
    expect(
      decideSessionEntry({
        activeSessionId: null,
        draftDirectory: null,
        canStartSession: true,
      }),
    ).toEqual({ type: "missing-session" });
  });
});
