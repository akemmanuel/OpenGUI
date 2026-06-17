import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { MANAGED_HARNESS_IDS } from "@opengui/runtime";
import { HARNESS_ID_VALUES } from "./harness-ids.ts";
import { CLI_COMMAND_BY_HARNESS, HARNESS_LABELS, HARNESS_REGISTRY } from "./harness-registry.ts";
import { HARNESS_BACKEND_META } from "./cli-harness-factory.ts";

describe("harness registry alignment", () => {
  test("registry ids match HARNESS_ID_VALUES", () => {
    expect(HARNESS_REGISTRY.map((e) => e.id).sort()).toEqual([...HARNESS_ID_VALUES].sort());
  });

  test("MANAGED_HARNESS_IDS matches HARNESS_ID_VALUES", () => {
    expect([...MANAGED_HARNESS_IDS].sort()).toEqual([...HARNESS_ID_VALUES].sort());
  });

  test("labels and cli commands cover every harness id", () => {
    for (const id of HARNESS_ID_VALUES) {
      expect(HARNESS_LABELS[id]).toBeTruthy();
      expect(CLI_COMMAND_BY_HARNESS[id]).toBeTruthy();
      expect(HARNESS_BACKEND_META[id]).toBeDefined();
    }
  });
});
