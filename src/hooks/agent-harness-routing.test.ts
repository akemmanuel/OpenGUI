import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  resolveActiveResourceHarnessRoute,
  resolvePendingPromptCreationHarnessRoute,
  resolveSessionHarnessRoute,
} from "@/hooks/agent-harness-routing";
import type { Session } from "@/hooks/agent-state-types";

function session(overrides: Partial<Session>): Session {
  return {
    id: "ses_test",
    title: "Test",
    time: { created: 1, updated: 1 },
    ...overrides,
  } as Session;
}

describe("Harness routing", () => {
  test("routes existing Session operations to the Session Harness", () => {
    expect(resolveSessionHarnessRoute(session({ _backendId: "codex" })).harnessId).toBe("codex");
  });

  test("infers legacy Session Harnesses from Session IDs", () => {
    expect(resolveSessionHarnessRoute(session({ id: "claude-code:abc" })).harnessId).toBe(
      "claude-code",
    );
  });

  test("does not invent a Harness for untagged existing Sessions", () => {
    expect(resolveSessionHarnessRoute(session({ id: "unknown" })).harnessId).toBeNull();
  });

  test("creates Pending prompt Sessions with active target Harness first", () => {
    expect(
      resolvePendingPromptCreationHarnessRoute({
        activeTargetBackendId: "pi",
        preferredBackendId: "opencode",
      }),
    ).toEqual({ harnessId: "pi", reason: "active-target", locked: false });
  });

  test("creates Pending prompt Sessions with preferred Harness when there is no active target", () => {
    expect(
      resolvePendingPromptCreationHarnessRoute({
        activeTargetBackendId: null,
        preferredBackendId: "opencode",
      }),
    ).toEqual({ harnessId: "opencode", reason: "preferred", locked: false });
  });

  test("loads active resources from active Session Harness first", () => {
    expect(
      resolveActiveResourceHarnessRoute({
        activeSession: session({ _backendId: "claude-code" }),
        activeTargetBackendId: "pi",
        preferredBackendId: "opencode",
      }),
    ).toEqual({ harnessId: "claude-code", reason: "session", locked: true });
  });

  test("loads active resources from active target before preferred Harness", () => {
    expect(
      resolveActiveResourceHarnessRoute({
        activeSession: null,
        activeTargetBackendId: "pi",
        preferredBackendId: "opencode",
      }),
    ).toEqual({ harnessId: "pi", reason: "active-target", locked: false });
  });
});
