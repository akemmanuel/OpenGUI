import { describe, expect, test, vi } from "vite-plus/test";
import { broadcastToAllWindows } from "./window-broadcast";

describe("broadcastToAllWindows", () => {
  test("sends only to live windows", () => {
    const liveSend = vi.fn();
    const destroyedSend = vi.fn();
    const windows = [
      { isDestroyed: () => false, webContents: { send: liveSend } },
      { isDestroyed: () => true, webContents: { send: destroyedSend } },
    ];

    broadcastToAllWindows("updates:state", { status: "ready" }, () => windows);

    expect(liveSend).toHaveBeenCalledWith("updates:state", { status: "ready" });
    expect(destroyedSend).not.toHaveBeenCalled();
  });
});
