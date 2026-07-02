import { describe, expect, test } from "vite-plus/test";
import { directoryRef } from "../directory-ref.ts";

describe("directoryRef", () => {
  test("builds scope row from canonical path", () => {
    const ref = directoryRef("/home/user/my-repo");
    expect(ref.id).toBe("/home/user/my-repo");
    expect(ref.path).toBe("/home/user/my-repo");
    expect(ref.canonicalPath).toBe("/home/user/my-repo");
    expect(ref.displayName).toBe("my-repo");
    expect(ref.createdAt).toBe(ref.updatedAt);
  });
});
