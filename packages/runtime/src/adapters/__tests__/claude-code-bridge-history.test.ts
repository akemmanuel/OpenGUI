import { describe, expect, test } from "vite-plus/test";
import { mapHistoryEntries } from "../claude-code-bridge-history.ts";

describe("claude-code-bridge-history", () => {
  test("mapHistoryEntries maps user assistant pair", () => {
    const mapped = mapHistoryEntries(
      [
        {
          uuid: "u1",
          type: "user",
          session_id: "s1",
          timestamp: "2020-01-01T00:00:00.000Z",
          message: { content: "hello" },
        },
      ],
      { directory: "/tmp" },
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.info.role).toBe("user");
    expect(mapped[0]?.parts[0]?.text).toBe("hello");
  });
});
