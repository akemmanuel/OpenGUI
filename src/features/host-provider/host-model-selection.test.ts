import { describe, expect, test, vi } from "vite-plus/test";
import type { OpenGuiHostClient } from "@/protocol/host-types";
import { persistHostModelSelection } from "./host-model-selection";

describe("persistHostModelSelection", () => {
  test("persists a model change to the active Host session", async () => {
    const snapshot = {
      id: "session-1",
      model: { connectionId: "anthropic", modelId: "claude-sonnet-4" },
    };
    const setModel = vi.fn().mockResolvedValue(snapshot);
    const host = { setModel } as unknown as OpenGuiHostClient;

    await expect(
      persistHostModelSelection(host, "session-1", {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      }),
    ).resolves.toBe(snapshot);
    expect(setModel).toHaveBeenCalledWith("session-1", {
      connectionId: "anthropic",
      modelId: "claude-sonnet-4",
    });
  });

  test("keeps a model selection local before a session exists", async () => {
    const setModel = vi.fn();
    const host = { setModel } as unknown as OpenGuiHostClient;

    await expect(
      persistHostModelSelection(host, null, {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      }),
    ).resolves.toBeNull();
    expect(setModel).not.toHaveBeenCalled();
  });
});
