import { describe, expect, test } from "vite-plus/test";
import { shouldApplyRequestBodyLimit } from "./create-backend-host";

describe("backend request body limiting", () => {
  test("does not reconstruct bodyless requests from the Node server adapter", () => {
    expect(shouldApplyRequestBodyLimit("GET")).toBe(false);
    expect(shouldApplyRequestBodyLimit("HEAD")).toBe(false);
    expect(shouldApplyRequestBodyLimit("DELETE")).toBe(false);
    expect(shouldApplyRequestBodyLimit("POST")).toBe(true);
    expect(shouldApplyRequestBodyLimit("PUT")).toBe(true);
    expect(shouldApplyRequestBodyLimit("PATCH")).toBe(true);
  });
});
