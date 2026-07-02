import { describe, expect, test, vi } from "vite-plus/test";
import {
  abortOpenCodeSseBeforeRestart,
  OPENCODE_SSE_ABORT_SETTLE_MS,
  shouldStopOpenCodeSseRead,
} from "../opencode-sse-lifecycle.ts";

describe("shouldStopOpenCodeSseRead", () => {
  test("stops when generation or lifecycle no longer matches", () => {
    expect(
      shouldStopOpenCodeSseRead({
        aborted: false,
        streamGeneration: 2,
        expectedGeneration: 1,
        lifecycle: 1,
        currentLifecycle: 1,
      }),
    ).toBe(true);
    expect(
      shouldStopOpenCodeSseRead({
        aborted: false,
        streamGeneration: 1,
        expectedGeneration: 1,
        lifecycle: 1,
        currentLifecycle: 2,
      }),
    ).toBe(true);
  });

  test("continues when gate matches and not aborted", () => {
    expect(
      shouldStopOpenCodeSseRead({
        aborted: false,
        streamGeneration: 3,
        expectedGeneration: 3,
        lifecycle: 5,
        currentLifecycle: 5,
      }),
    ).toBe(false);
  });
});

describe("abortOpenCodeSseBeforeRestart", () => {
  test("aborts controller and waits settle window", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const controller = { abort } as unknown as AbortController;
    const promise = abortOpenCodeSseBeforeRestart(controller, 50);
    expect(abort).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await promise;
    vi.useRealTimers();
  });

  test("default settle matches OPENCODE_SSE_ABORT_SETTLE_MS", () => {
    expect(OPENCODE_SSE_ABORT_SETTLE_MS).toBe(100);
  });
});
