import { describe, expect, test } from "vite-plus/test";
import type { HostSessionSnapshot } from "@/protocol/host-types";
import type { Session } from "@/hooks/agent-state-types";
import { applyHostModelSnapshot, selectedModelFromHostSnapshot } from "./host-session-selection";

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

  test("applies the authoritative model snapshot to the matching session", () => {
    const sessions = [
      {
        id: "session-1",
        title: "Session",
        directory: "/project",
        time: { created: 1, updated: 2 },
        model: { providerID: "provider-1", id: "gpt-5.6-sol" },
      },
    ] as Session[];
    const snapshot = {
      id: "session-1",
      updatedAt: "2026-01-01T00:00:03.000Z",
      model: { connectionId: "provider-1", modelId: "gpt-5.6-luna" },
    } as HostSessionSnapshot;

    expect(applyHostModelSnapshot(sessions, snapshot)[0]).toEqual(
      expect.objectContaining({
        model: { providerID: "provider-1", id: "gpt-5.6-luna" },
        time: expect.objectContaining({ updated: Date.parse(snapshot.updatedAt) }),
      }),
    );
  });
});
