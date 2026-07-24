import { describe, expect, test } from "vite-plus/test";
import { buildSystemPrompt } from "./system-prompt.ts";

describe("buildSystemPrompt", () => {
  test("keeps identity and env without restating tool docs", () => {
    const prompt = buildSystemPrompt({
      projectDirectory: "/tmp/proj",
      shell: { executable: "/bin/bash", family: "posix" },
      skills: [],
      now: new Date("2026-07-24T12:00:00.000Z"),
      platform: "linux",
    });

    expect(prompt).toBe(
      [
        "You are OpenGUI's local general-purpose agent.",
        "Current date: 2026-07-24",
        "Project directory: /tmp/proj",
        "Operating system: linux",
        "Shell: /bin/bash (posix)",
      ].join("\n"),
    );
    expect(prompt).not.toMatch(/^read:/mu);
    expect(prompt).not.toContain("Prefer concise");
  });

  test("omits shell env when shell is not an available tool", () => {
    const prompt = buildSystemPrompt({
      projectDirectory: "/tmp/proj",
      shell: { executable: "/bin/bash", family: "posix" },
      tools: ["read"],
      skills: [
        {
          name: "project-skill",
          description: "Project-local guidance.",
          filePath: "/tmp/proj/.agents/skills/project-skill/SKILL.md",
          baseDir: "/tmp/proj/.agents/skills/project-skill",
          source: "project",
          disableModelInvocation: false,
        },
      ],
      now: new Date("2026-07-24T12:00:00.000Z"),
      platform: "linux",
    });

    expect(prompt).not.toMatch(/\bshell\b/iu);
    expect(prompt).not.toMatch(/\b(?:write|edit)\b/iu);
    expect(prompt).toContain("project-skill");
  });
});
