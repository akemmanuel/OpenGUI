// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { Session } from "@/hooks/agent-state-types";
import { useSessionMessageSearch } from "./use-session-message-search";

function session(id: string, directory: string): Session {
  return { id, title: id, directory, _projectDir: directory } as Session;
}

describe("useSessionMessageSearch", () => {
  afterEach(() => vi.useRealTimers());

  test("batches all Project directories into one debounced request", async () => {
    vi.useFakeTimers();
    const searchSessionMessages = vi.fn().mockResolvedValue(["one", "two"]);
    const { result, rerender } = renderHook(
      ({ query }) =>
        useSessionMessageSearch({
          sessions: [session("one", "/first"), session("two", "/second")],
          query,
          searchSessionMessages,
        }),
      { initialProps: { query: "needle" } },
    );

    expect(result.current.isPending).toBe(true);
    expect(result.current.effectiveQuery).toBe("");
    expect([...result.current.matchingSessionIds]).toEqual([]);

    await act(() => vi.advanceTimersByTimeAsync(35));

    expect(searchSessionMessages).toHaveBeenCalledTimes(1);
    expect(searchSessionMessages).toHaveBeenCalledWith(["/first", "/second"], "needle");
    expect(result.current.isPending).toBe(false);
    expect(result.current.effectiveQuery).toBe("needle");
    expect([...result.current.matchingSessionIds]).toEqual(["one", "two"]);

    rerender({ query: "new needle" });
    expect(result.current.isPending).toBe(true);
    expect(result.current.effectiveQuery).toBe("needle");
    expect([...result.current.matchingSessionIds]).toEqual(["one", "two"]);

    await act(() => vi.advanceTimersByTimeAsync(35));
    expect(result.current.isPending).toBe(false);
    expect(result.current.effectiveQuery).toBe("new needle");
    expect(searchSessionMessages).toHaveBeenCalledTimes(2);
  });
});
