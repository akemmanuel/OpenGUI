import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { HarnessDescriptor } from "@/agents/backend";
import { resolveActiveHarnessScope } from "@/hooks/active-harness-scope";
import type { Session } from "@/hooks/agent-state-types";
import type { OpenGuiClient } from "@/protocol/client";

function session(overrides: Partial<Session>): Session {
  return {
    id: "session-1",
    title: "Test",
    directory: "/repo",
    time: { created: 1, updated: 1 },
    ...overrides,
  } as Session;
}

function harness(id: string): HarnessDescriptor {
  return {
    id,
    label: id,
    capabilities: {},
    runtime: { id } as never,
    connection: { kind: "remote" } as never,
  } as unknown as HarnessDescriptor;
}

function client(fallbackHarness: HarnessDescriptor): OpenGuiClient {
  return {
    harnesses: {
      get: () => fallbackHarness,
    },
  } as never;
}

describe("resolveActiveHarnessScope", () => {
  test("locks scope to the active Session Harness and directory", () => {
    const codex = harness("codex");
    const scope = resolveActiveHarnessScope({
      activeSession: session({ _harnessId: "codex", _projectDir: "/session-repo" }),
      activeTargetDirectory: "/target-repo",
      activeTargetBackendId: "pi",
      workspaceDirectory: "/workspace-repo",
      preferredBackendId: "opencode",
      backendsById: { codex },
      openGuiClient: client(harness("fallback")),
    });

    expect(scope.harnessId).toBe("codex");
    expect(scope.directory).toBe("/session-repo");
    expect(scope.harness).toBe(codex);
    expect(scope.runtime).toBe(codex.runtime);
    expect(scope.connectionProfile).toBe(codex.connection);
    expect(scope.route).toEqual({ harnessId: "codex", reason: "session", locked: true });
  });

  test("uses active target before preferred when no Session is active", () => {
    const pi = harness("pi");
    const scope = resolveActiveHarnessScope({
      activeSession: null,
      activeTargetDirectory: "/target-repo",
      activeTargetBackendId: "pi",
      workspaceDirectory: "/workspace-repo",
      preferredBackendId: "opencode",
      backendsById: { pi },
      openGuiClient: client(harness("fallback")),
    });

    expect(scope.harnessId).toBe("pi");
    expect(scope.directory).toBe("/target-repo");
    expect(scope.harness).toBe(pi);
    expect(scope.route).toEqual({ harnessId: "pi", reason: "active-target", locked: false });
  });

  test("falls back to preferred Harness and workspace directory", () => {
    const fallback = harness("opencode");
    const scope = resolveActiveHarnessScope({
      activeSession: null,
      activeTargetDirectory: null,
      activeTargetBackendId: null,
      workspaceDirectory: "/workspace-repo",
      preferredBackendId: "opencode",
      backendsById: {},
      openGuiClient: client(fallback),
    });

    expect(scope.harnessId).toBe("opencode");
    expect(scope.directory).toBe("/workspace-repo");
    expect(scope.harness).toBe(fallback);
    expect(scope.route).toEqual({ harnessId: "opencode", reason: "preferred", locked: false });
  });
});
