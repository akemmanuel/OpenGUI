import { describe, expect, test } from "vite-plus/test";
import {
  EMPTY_SESSION_MULTI_SELECT,
  pruneSessionSelection,
  selectSessionRange,
  toggleSessionSelection,
} from "./session-multi-select";

describe("session multi-selection", () => {
  test("toggles individual sessions and moves the anchor", () => {
    let state = toggleSessionSelection(EMPTY_SESSION_MULTI_SELECT, "b");
    state = toggleSessionSelection(state, "d");
    expect([...state.selectedIds]).toEqual(["b", "d"]);
    expect(state.anchorId).toBe("d");
    state = toggleSessionSelection(state, "b");
    expect([...state.selectedIds]).toEqual(["d"]);
  });

  test("selects a visible range in either direction", () => {
    const state = toggleSessionSelection(EMPTY_SESSION_MULTI_SELECT, "d");
    const ranged = selectSessionRange(state, "b", ["a", "b", "c", "d", "e"]);
    expect([...ranged.selectedIds]).toEqual(["b", "c", "d"]);
    expect(ranged.anchorId).toBe("d");
  });

  test("uses the target as anchor when there is no valid anchor", () => {
    const ranged = selectSessionRange(EMPTY_SESSION_MULTI_SELECT, "c", ["a", "b", "c"]);
    expect([...ranged.selectedIds]).toEqual(["c"]);
    expect(ranged.anchorId).toBe("c");
  });

  test("prunes hidden sessions and a hidden anchor", () => {
    const state = { selectedIds: new Set(["a", "b"]), anchorId: "a" };
    const pruned = pruneSessionSelection(state, ["b", "c"]);
    expect([...pruned.selectedIds]).toEqual(["b"]);
    expect(pruned.anchorId).toBeNull();
  });
});
