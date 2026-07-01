import { describe, expect, test } from "vite-plus/test";
import { planDirectoryChangePrompt } from "@/hooks/agent-directory-change-notice";

describe("planDirectoryChangePrompt", () => {
  test("leaves prompts unchanged (directory notices deferred)", () => {
    expect(
      planDirectoryChangePrompt({
        text: "Continue",
        meta: { displayProjectDir: "/target" },
      }),
    ).toEqual({ text: "Continue" });
  });
});
