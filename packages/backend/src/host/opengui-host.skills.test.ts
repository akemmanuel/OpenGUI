import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { OpenGuiHost } from "./opengui-host.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeSkill(
  root: string,
  name: string,
  description: string,
  options?: { disableModelInvocation?: boolean },
) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    ...(options?.disableModelInvocation ? ["disable-model-invocation: true"] : []),
    "---",
    `# ${name}`,
    "",
  ];
  await writeFile(join(dir, "SKILL.md"), `${lines.join("\n")}\n`);
}

describe("OpenGuiHost.listSkills", () => {
  test("returns project and host skills for an authorized directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-skills-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const home = join(root, "home");
    await mkdir(project, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeSkill(join(project, ".agents", "skills"), "project-skill", "Project guidance.");
    await writeSkill(join(home, ".agents", "skills"), "host-skill", "Host guidance.");
    await writeSkill(join(home, ".agents", "skills"), "hidden", "Hidden guidance.", {
      disableModelInvocation: true,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const host = new OpenGuiHost(root);
    try {
      await host.start();
      await host.registerProject(project);
      await expect(host.listSkills(project)).resolves.toEqual([
        {
          name: "hidden",
          description: "Hidden guidance.",
          source: "host",
          manual: true,
        },
        {
          name: "project-skill",
          description: "Project guidance.",
          source: "project",
          manual: false,
        },
        {
          name: "host-skill",
          description: "Host guidance.",
          source: "host",
          manual: false,
        },
      ]);
    } finally {
      await host.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
