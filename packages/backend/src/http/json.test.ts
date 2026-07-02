import { describe, expect, test } from "vite-plus/test";
import { isPlainObject, jsonError } from "./json.ts";

describe("http/json helpers", () => {
  test("isPlainObject rejects arrays and null", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });

  test("jsonError maps not found to BACKEND_UNAVAILABLE", async () => {
    const response = jsonError(new Error("Session not found"), 404);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "Session not found",
      code: "BACKEND_UNAVAILABLE",
      recoverable: true,
    });
  });

  test("jsonError maps auth errors to AUTH_REQUIRED", async () => {
    const response = jsonError(new Error("Please login"), 500);
    expect(await response.json()).toMatchObject({ code: "AUTH_REQUIRED", recoverable: false });
  });

  test("jsonError maps permission errors", async () => {
    const response = jsonError(new Error("permission denied"), 403);
    expect(await response.json()).toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
