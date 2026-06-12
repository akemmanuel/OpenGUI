import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { NativeBackendEvent } from "@/types/electron";
import { normalizeClaudeCodeEvent } from "./claude-code";
import { normalizeCodexEvent } from "./codex";
import { normalizePiEvent } from "./pi";

type CliHarnessCase = readonly [
  harnessId: "claude-code" | "codex" | "pi",
  normalizeEvent: (event: NativeBackendEvent) => unknown,
];

const cliHarnessCases: readonly CliHarnessCase[] = [
  ["claude-code", normalizeClaudeCodeEvent],
  ["codex", normalizeCodexEvent],
  ["pi", normalizePiEvent],
] as const;

describe("CLI harness normalizers", () => {
  for (const [harnessId, normalizeEvent] of cliHarnessCases) {
    test(`normalizes tagged ${harnessId} events`, () => {
      const event = {
        type: `${harnessId}:event`,
        payload: {
          type: "session.deleted",
          directory: "/repo",
          sessionId: "raw-session",
        },
      } as unknown as NativeBackendEvent;

      expect(normalizeEvent(event)).toEqual({
        type: "session.deleted",
        directory: "/repo",
        sessionId: `${harnessId}:raw-session`,
      });
    });
  }

  test("ignores another CLI harness event channel", () => {
    const event = {
      type: "pi:event",
      payload: { type: "session.deleted", directory: "/repo", sessionId: "raw-session" },
    } as unknown as NativeBackendEvent;

    expect(normalizeCodexEvent(event)).toBeNull();
  });
});
