import { describe, expect, test } from "vite-plus/test";
import { decideSharedSessionPrompt } from "./shared-session-control.ts";

describe("decideSharedSessionPrompt", () => {
  test("queues prompts for a running shared Session", () => {
    expect(decideSharedSessionPrompt({ sessionStatus: "running" })).toBe("queue");
  });

  test("dispatches prompts for a non-running shared Session", () => {
    expect(decideSharedSessionPrompt({ sessionStatus: "idle" })).toBe("dispatch");
    expect(decideSharedSessionPrompt({ sessionStatus: "error" })).toBe("dispatch");
    expect(decideSharedSessionPrompt({ sessionStatus: "unknown" })).toBe("dispatch");
  });
});
