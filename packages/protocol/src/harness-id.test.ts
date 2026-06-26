import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_HARNESS_ID, HARNESS_ID_VALUES, isHarnessIdValue } from "./harness-id.ts";

describe("@opengui/protocol harness ids", () => {
  test("exposes stable harness id list", () => {
    expect(HARNESS_ID_VALUES).toContain("opencode");
    expect(HARNESS_ID_VALUES).toContain("claude-code");
    expect(DEFAULT_HARNESS_ID).toBe("claude-code");
  });

  test("isHarnessIdValue narrows known ids", () => {
    expect(isHarnessIdValue("pi")).toBe(true);
    expect(isHarnessIdValue("not-a-harness")).toBe(false);
  });
});
