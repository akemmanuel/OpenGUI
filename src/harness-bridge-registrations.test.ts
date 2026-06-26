import { describe, expect, test } from "vite-plus/test";
import { HARNESS_ID_VALUES } from "./agents/harness-ids.ts";
import { BRIDGE_SETUP_BY_HARNESS_ID } from "../packages/runtime/src/harness-bridge-registrations.ts";

describe("harness bridge registrations", () => {
  test("BRIDGE_SETUP_BY_HARNESS_ID keys match HARNESS_ID_VALUES", () => {
    expect(Object.keys(BRIDGE_SETUP_BY_HARNESS_ID).sort()).toEqual([...HARNESS_ID_VALUES].sort());
  });

  test("every harness has a register function", () => {
    for (const id of HARNESS_ID_VALUES) {
      expect(typeof BRIDGE_SETUP_BY_HARNESS_ID[id]).toBe("function");
    }
  });
});
