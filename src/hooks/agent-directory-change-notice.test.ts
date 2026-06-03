import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { planDirectoryChangePrompt } from "@/hooks/agent-directory-change-notice";

describe("planDirectoryChangePrompt", () => {
  test("leaves prompts unchanged when no notice is pending", () => {
    expect(
      planDirectoryChangePrompt({
        text: "Continue",
        meta: { assignedProjectDir: "/target", pendingDirectoryChangeNotice: false },
      }),
    ).toEqual({ text: "Continue" });
  });

  test("prepends the reassigned Project notice and returns the metadata patch", () => {
    const plan = planDirectoryChangePrompt({
      text: "Continue",
      session: { id: "session-1", directory: "/original/" } as never,
      meta: {
        assignedProjectDir: "/target/",
        assignedProjectSourceDir: "/source/",
        pendingDirectoryChangeNotice: true,
      },
    });

    expect(plan.text).toContain("<SYSTEM-APPEND>");
    expect(plan.text).toContain("`/source`");
    expect(plan.text).toContain("`/target`");
    expect(plan.text.endsWith("\n\nContinue")).toBe(true);
    expect(plan.metaPatch).toEqual({
      pendingDirectoryChangeNotice: false,
      hideSystemAppendBlocks: true,
    });
  });
});
