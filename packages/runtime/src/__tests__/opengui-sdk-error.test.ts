import { describe, expect, test } from "vite-plus/test";
import { OpenGuiSdkError } from "../opengui-sdk-error.ts";

describe("OpenGuiSdkError", () => {
  test("exposes code and name", () => {
    const err = new OpenGuiSdkError("SESSION_BUSY", "busy");
    expect(err.code).toBe("SESSION_BUSY");
    expect(err.name).toBe("OpenGuiSdkError");
    expect(err.message).toBe("busy");
    expect(err).toBeInstanceOf(Error);
  });
});
