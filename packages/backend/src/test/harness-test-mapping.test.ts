import { describe, expect, test } from "vite-plus/test";
import { asHarnessString } from "./harness-test-mapping.ts";

describe("harness-test-mapping", () => {
  test("asHarnessString coerces unknown values", () => {
    expect(asHarnessString("ok")).toBe("ok");
    expect(asHarnessString(1)).toBe("");
    expect(asHarnessString(null, "fb")).toBe("fb");
    expect(asHarnessString({ x: 1 })).toBe("");
  });
});
