import { describe, expect, test } from "vite-plus/test";
import { getNextPrimaryAgent } from "@/hooks/use-primary-agent-cycle";

describe("getNextPrimaryAgent", () => {
  test("cycles forward from build to the next agent", () => {
    expect(
      getNextPrimaryAgent({ primaryAgents: ["build", "plan", "review"], selectedAgent: null }),
    ).toBe("plan");
  });

  test("cycles backward when shift is pressed", () => {
    expect(
      getNextPrimaryAgent({
        primaryAgents: ["build", "plan", "review"],
        selectedAgent: "plan",
        shiftKey: true,
      }),
    ).toBeNull();
  });

  test("wraps forward and maps build to null", () => {
    expect(
      getNextPrimaryAgent({
        primaryAgents: ["build", "plan", "review"],
        selectedAgent: "review",
      }),
    ).toBeNull();
  });

  test("starts from the first primary agent when selected agent is unknown", () => {
    expect(
      getNextPrimaryAgent({
        primaryAgents: ["build", "plan", "review"],
        selectedAgent: "other",
      }),
    ).toBe("plan");
  });
});
