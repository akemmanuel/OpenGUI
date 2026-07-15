import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { discoverSkills, loadSkillsFromDir } from "./discover.ts";
import { formatSkillsForPrompt } from "./format-prompt.ts";
import { parseFrontmatter } from "./parse.ts";

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "opengui-skills-"));
}

async function writeSkill(
  root: string,
  name: string,
  body: string,
  frontmatter: Record<string, string | boolean> = {},
) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const lines = ["---"];
  lines.push(`name: ${typeof frontmatter.name === "string" ? frontmatter.name : name}`);
  lines.push(
    `description: ${
      typeof frontmatter.description === "string"
        ? frontmatter.description
        : `Use ${name} when relevant.`
    }`,
  );
  if (frontmatter["disable-model-invocation"] === true) {
    lines.push("disable-model-invocation: true");
  }
  lines.push("---", "", body);
  await writeFile(join(dir, "SKILL.md"), `${lines.join("\n")}\n`);
  return join(dir, "SKILL.md");
}

describe("parseFrontmatter", () => {
  test("parses name, description, and disable-model-invocation", () => {
    const { frontmatter, body } = parseFrontmatter(`---
name: pdf-processing
description: Handle PDFs when the user mentions PDF files.
disable-model-invocation: true
---

# PDF
`);
    expect(frontmatter).toEqual({
      name: "pdf-processing",
      description: "Handle PDFs when the user mentions PDF files.",
      "disable-model-invocation": true,
    });
    expect(body.trim()).toBe("# PDF");
  });

  test("keeps description values that contain colons", () => {
    const { frontmatter } = parseFrontmatter(`---
name: demo
description: Use this skill when: the user asks about demos
---
body
`);
    expect(frontmatter.description).toBe("Use this skill when: the user asks about demos");
  });
});

describe("loadSkillsFromDir", () => {
  test("discovers nested SKILL.md and ignores root markdown files", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "README.md"), "# not a skill\n");
    const path = await writeSkill(root, "code-review", "# Review carefully");
    await mkdir(join(root, "nested", "deep"), { recursive: true });
    await writeSkill(join(root, "nested"), "data-analysis", "# Analyze");

    const result = loadSkillsFromDir(root, "project");
    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      "code-review",
      "data-analysis",
    ]);
    expect(result.skills.find((skill) => skill.name === "code-review")?.filePath).toBe(path);
  });

  test("skips skills without a description", async () => {
    const root = await temporaryDirectory();
    const dir = join(root, "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: broken\n---\n# no description\n");

    const result = loadSkillsFromDir(root, "project");
    expect(result.skills).toEqual([]);
    expect(result.diagnostics.some((item) => item.type === "error")).toBe(true);
  });
});

describe("discoverSkills", () => {
  test("loads project and host .agents/skills with project winning collisions", async () => {
    const home = await temporaryDirectory();
    const project = await temporaryDirectory();
    await writeSkill(join(home, ".agents", "skills"), "shared", "host body", {
      description: "Host shared skill.",
    });
    await writeSkill(join(home, ".agents", "skills"), "host-only", "host only", {
      description: "Host only skill.",
    });
    const projectPath = await writeSkill(
      join(project, ".agents", "skills"),
      "shared",
      "project body",
      {
        description: "Project shared skill.",
      },
    );

    const result = discoverSkills({ projectDirectory: project, homeDirectory: home });
    expect(result.skills.map((skill) => skill.name).sort()).toEqual(["host-only", "shared"]);
    expect(result.skills.find((skill) => skill.name === "shared")).toMatchObject({
      filePath: projectPath,
      source: "project",
      description: "Project shared skill.",
    });
    expect(result.diagnostics.some((item) => item.type === "collision")).toBe(true);
  });

  test("does not load non-.agents skill directories", async () => {
    const home = await temporaryDirectory();
    const project = await temporaryDirectory();
    await writeSkill(join(project, ".opengui", "skills"), "custom", "should ignore");
    await writeSkill(join(project, ".pi", "skills"), "pi-skill", "should ignore");

    const result = discoverSkills({ projectDirectory: project, homeDirectory: home });
    expect(result.skills).toEqual([]);
  });

  test("inside a git repo, includes monorepo root .agents/skills", async () => {
    const home = await temporaryDirectory();
    const repo = await temporaryDirectory();
    const packageDir = join(repo, "packages", "app");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeSkill(join(repo, ".agents", "skills"), "repo-skill", "from repo", {
      description: "Repo skill.",
    });
    await writeSkill(join(packageDir, ".agents", "skills"), "pkg-skill", "from package", {
      description: "Package skill.",
    });

    const result = discoverSkills({ projectDirectory: packageDir, homeDirectory: home });
    expect(result.skills.map((skill) => skill.name).sort()).toEqual(["pkg-skill", "repo-skill"]);
  });
});

describe("formatSkillsForPrompt", () => {
  test("formats XML catalog and omits disable-model-invocation skills", () => {
    const prompt = formatSkillsForPrompt([
      {
        name: "code-review",
        description: 'Review "code" & PRs',
        filePath: "/tmp/.agents/skills/code-review/SKILL.md",
        baseDir: "/tmp/.agents/skills/code-review",
        source: "project",
        disableModelInvocation: false,
      },
      {
        name: "hidden",
        description: "Hidden",
        filePath: "/tmp/.agents/skills/hidden/SKILL.md",
        baseDir: "/tmp/.agents/skills/hidden",
        source: "host",
        disableModelInvocation: true,
      },
    ]);

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>code-review</name>");
    expect(prompt).toContain("<description>Review &quot;code&quot; &amp; PRs</description>");
    expect(prompt).toContain("<location>/tmp/.agents/skills/code-review/SKILL.md</location>");
    expect(prompt).toContain("use the read tool");
    expect(prompt).not.toContain("hidden");
  });

  test("returns empty string when no visible skills", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });
});
