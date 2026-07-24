// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { useActiveSessionQueue } from "./useActiveSessionQueue";

afterEach(cleanup);

describe("useActiveSessionQueue", () => {
  test("routes every queue action to the currently active Session across queue churn", () => {
    const actions = {
      getQueuedPrompts: vi.fn((id: string) =>
        id === "a" ? [{ id: "1" }, { id: "2" }] : [{ id: "3" }],
      ),
      removeFromQueue: vi.fn(),
      reorderQueue: vi.fn(),
      updateQueuedPrompt: vi.fn(),
      sendQueuedNow: vi.fn(),
    };
    const { result, rerender } = renderHook(
      ({ id }) => useActiveSessionQueue({ activeSessionId: id, ...actions } as never),
      { initialProps: { id: "a" as string | null } },
    );
    act(() => {
      result.current.queueHandlers.remove("1");
      result.current.queueHandlers.moveUp(1);
      result.current.queueHandlers.moveDown(0);
      result.current.queueHandlers.moveToTop(1);
      result.current.queueHandlers.moveToBottom(0);
      result.current.queueHandlers.edit("2", "changed");
      result.current.queueHandlers.sendNow("2");
      result.current.queueHandlers.reorder(1, 0);
    });
    expect(actions.removeFromQueue).toHaveBeenCalledWith("a", "1");
    expect(actions.reorderQueue.mock.calls).toEqual([
      ["a", 1, 0],
      ["a", 0, 1],
      ["a", 1, 0],
      ["a", 0, 1],
      ["a", 1, 0],
    ]);
    expect(actions.updateQueuedPrompt).toHaveBeenCalledWith("a", "2", "changed");
    expect(actions.sendQueuedNow).toHaveBeenCalledWith("a", "2");

    rerender({ id: "b" });
    act(() => result.current.queueHandlers.moveToBottom(0));
    expect(actions.reorderQueue).toHaveBeenLastCalledWith("b", 0, 0);
    rerender({ id: null });
    const callCount = actions.reorderQueue.mock.calls.length;
    act(() => result.current.queueHandlers.moveDown(0));
    expect(result.current.queuedPrompts).toEqual([]);
    expect(actions.reorderQueue).toHaveBeenCalledTimes(callCount);
  });
});
