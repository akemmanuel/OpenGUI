import { describe, expect, it, vi } from "vite-plus/test";
import type { ActionsContextValue } from "@/hooks/agent-contexts";
import type { HostFollowUp, OpenGuiHostClient } from "@/protocol/host-types";
import { HostActionFactory, HostQueueController, type HostQueueState } from "./host-actions";

describe("HostActionFactory", () => {
  it("creates the coordinated action contract lazily", () => {
    const actions = { clearError: vi.fn() } as unknown as ActionsContextValue;
    const create = vi.fn(() => actions);
    const factory = new HostActionFactory(create);

    expect(create).not.toHaveBeenCalled();
    expect(factory.create()).toBe(actions);
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("HostQueueController", () => {
  it("keeps frontend Follow-ups synchronized with Host queue mutations", async () => {
    let state: HostQueueState = {};
    const followUp = (id: string, text: string, sequence: number): HostFollowUp => ({
      id,
      sequence,
      prompt: { text },
      createdAt: "2026-07-10T10:00:00.000Z",
    });
    const updateFollowUp = vi.fn(async () => [followUp("second", "Edited", 1)]);
    const reorderFollowUp = vi.fn(async () => [followUp("second", "Edited", 1)]);
    const removeFollowUp = vi.fn(async () => []);
    const sendFollowUpNow = vi.fn(async () => []);
    const host = {
      updateFollowUp,
      reorderFollowUp,
      removeFollowUp,
      sendFollowUpNow,
    } as unknown as OpenGuiHostClient;
    const controller = new HostQueueController(
      host,
      () => state,
      (update) => {
        state = update(state);
      },
    );

    controller.recordEnqueued("session", followUp("first", "First", 1));
    controller.recordEnqueued("session", followUp("second", "Second", 2));
    await controller.update("session", "second", "Edited");
    controller.recordEnqueued("session", followUp("first", "First", 2));
    await controller.reorder("session", 1, 0);
    await controller.remove("session", "second");
    controller.recordEnqueued("session", followUp("second", "Edited", 1));
    await controller.sendNow("session", "second");

    expect(updateFollowUp).toHaveBeenCalledWith("session", "second", "Edited");
    expect(reorderFollowUp).toHaveBeenCalledWith("session", "first", 0);
    expect(removeFollowUp).toHaveBeenCalledWith("session", "second");
    expect(sendFollowUpNow).toHaveBeenCalledWith("session", "second");
    expect(state.session).toEqual([]);
  });
});
