import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { NativeBackendEvent } from "@/types/electron";
import { HARNESS_BACKEND_META } from "./cli-harness-factory";

type CliHarnessCase = readonly [
  harnessId: "claude-code" | "codex" | "pi" | "grok-build",
  normalizeEvent: (event: NativeBackendEvent) => unknown,
];

const cliHarnessCases: readonly CliHarnessCase[] = [
  ["claude-code", HARNESS_BACKEND_META["claude-code"].normalizeEvent],
  ["codex", HARNESS_BACKEND_META.codex.normalizeEvent],
  ["pi", HARNESS_BACKEND_META.pi.normalizeEvent],
  ["grok-build", HARNESS_BACKEND_META["grok-build"].normalizeEvent],
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

    expect(HARNESS_BACKEND_META.codex.normalizeEvent(event)).toBeNull();
  });
});
