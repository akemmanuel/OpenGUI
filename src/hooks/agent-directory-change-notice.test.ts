import { describe, expect, test } from "vite-plus/test";
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

  test("uses the backend session directory as target when moving back to the original project", () => {
    const plan = planDirectoryChangePrompt({
      text: "Where are you?",
      session: { id: "session-1", directory: "/original/" } as never,
      meta: {
        assignedProjectDir: null,
        assignedProjectSourceDir: "/previous-target/",
        pendingDirectoryChangeNotice: true,
      },
    });

    expect(plan.text).toContain("`/previous-target`");
    expect(plan.text).toContain("`/original`");
    expect(plan.text.endsWith("\n\nWhere are you?")).toBe(true);
  });
});
