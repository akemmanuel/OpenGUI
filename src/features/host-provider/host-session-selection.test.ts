import { describe, expect, test } from "vite-plus/test";
import type { HostSessionSnapshot } from "@/protocol/host-types";
import { selectedModelFromHostSnapshot } from "./host-session-selection";

describe("selectedModelFromHostSnapshot", () => {
  test("restores the model saved in the selected session", () => {
    const snapshot = {
      id: "session-1",
      model: { connectionId: "anthropic", modelId: "claude-sonnet-4" },
    } as HostSessionSnapshot;

    expect(selectedModelFromHostSnapshot(snapshot)).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    });
  });

  test("clears the selection when the session has no model", () => {
    const snapshot = { id: "session-1", model: null } as HostSessionSnapshot;

    expect(selectedModelFromHostSnapshot(snapshot)).toBeNull();
  });
});
