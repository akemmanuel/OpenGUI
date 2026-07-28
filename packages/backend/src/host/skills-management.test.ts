import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  createGitHubSkillSourceResolver,
  parseSkillSource,
  SkillManagementError,
  SkillsManager,
  validateRelativePath,
  type ResolvedSkillSource,
} from "./skills-management.ts";

const roots: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opengui-skill-management-"));
  roots.push(root);
  return { root, project: join(root, "project"), home: join(root, "home") };
}

function source(
  description = "Pinned instructions.",
  revision = "a".repeat(40),
): ResolvedSkillSource {
  return {
    requested: "github:acme/skills/demo@main",
    canonical: `github:acme/skills/demo@${revision}`,
    revision,
    path: "demo",
    files: [
      {
        path: "SKILL.md",
        contents: encoder.encode(`---\nname: demo\ndescription: ${description}\n---\n# Demo\n`),
      },
      { path: "references/guide.md", contents: encoder.encode("instructions\n") },
    ],
  };
}

describe("skill source grammar and path safety", () => {
  test("resolves a mutable GitHub ref to a commit and downloads blobs without a shell", async () => {
    const sha = "c".repeat(40);
    const requests: string[] = [];
    const resolver = createGitHubSkillSourceResolver(async (url) => {
      const requestedUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requests.push(requestedUrl);
      if (requestedUrl.endsWith("/commits/main"))
        return Response.json({ sha, commit: { tree: { sha: "tree-sha" } } });
      if (requestedUrl.endsWith("/git/trees/tree-sha?recursive=1"))
        return Response.json({
          truncated: false,
          tree: [
            { path: "demo", type: "tree", mode: "040000" },
            {
              path: "demo/SKILL.md",
              type: "blob",
              mode: "100644",
              size: 64,
              url: "https://api.github.test/blob/skill",
            },
          ],
        });
      if (requestedUrl === "https://api.github.test/blob/skill")
        return new Response("---\nname: demo\ndescription: Demo.\n---\n");
      return new Response("missing", { status: 404 });
    });

    const resolved = await resolver("github:acme/skills/demo@main");

    expect(resolved).toMatchObject({
      revision: sha,
      canonical: `github:acme/skills/demo@${sha}`,
      path: "demo",
    });
    expect(requests).toHaveLength(3);
  });

  test("accepts only the documented explicit and legacy GitHub grammars", () => {
    expect(parseSkillSource("github:acme/skills/review@main")).toMatchObject({
      owner: "acme",
      repo: "skills",
      path: "review",
      ref: "main",
      legacy: false,
    });
    expect(parseSkillSource("acme/skills@review")).toMatchObject({
      path: "review",
      ref: "HEAD",
      legacy: true,
    });
    for (const invalid of [
      "https://example.com/archive.zip",
      "git@github.com:acme/skills",
      "github:acme/skills/../review@main",
      "github:acme/skills/review@../../head",
    ]) {
      expect(() => parseSkillSource(invalid), invalid).toThrow(SkillManagementError);
    }
  });

  test.each([
    "../escape",
    "/absolute",
    "C:/drive",
    "\\\\server\\share",
    "folder\\file",
    "folder/file:stream",
    "folder/con",
    "folder/trailing. ",
    "folder/control\u0001",
  ])("rejects unsafe portable path %j", (path) => {
    expect(() => validateRelativePath(path)).toThrow(SkillManagementError);
  });
});

describe("SkillsManager", () => {
  test("installs, resolves immutable metadata, and replays a request id without a new generation", async () => {
    const { project, home } = await fixture();
    await mkdir(project, { recursive: true });
    let authorizations = 0;
    const manager = new SkillsManager({
      homeDirectory: home,
      resolver: async () => source(),
      authorizeManagement: async () => {
        authorizations += 1;
      },
    });
    const input = {
      source: "github:acme/skills/demo@main",
      scope: "project" as const,
      projectDirectory: project,
      requestId: "request_install_1",
    };

    const installed = await manager.install(input);
    const replayed = await manager.install(input);

    expect(installed).toMatchObject({
      name: "demo",
      managed: true,
      modified: false,
      generation: 1,
      revision: "a".repeat(40),
      resolvedSource: `github:acme/skills/demo@${"a".repeat(40)}`,
    });
    expect(replayed.generation).toBe(1);
    expect(authorizations).toBe(3); // initial+precommit, then replay admission
    expect(
      await readFile(join(project, ".agents", "skills", "demo", "SKILL.md"), "utf8"),
    ).toContain("Pinned instructions.");
  });

  test("updates atomically and blocks destructive operations after local modification", async () => {
    const { project, home } = await fixture();
    await mkdir(project, { recursive: true });
    let current = source("Version one.", "a".repeat(40));
    const manager = new SkillsManager({ homeDirectory: home, resolver: async () => current });
    await manager.install({
      source: current.requested,
      scope: "project",
      projectDirectory: project,
      requestId: "request_install_2",
    });
    current = source("Version two.", "b".repeat(40));
    const updated = await manager.update({
      name: "demo",
      scope: "project",
      projectDirectory: project,
      requestId: "request_update_2",
      expectedGeneration: 1,
    });
    expect(updated).toMatchObject({ generation: 2, revision: "b".repeat(40) });
    const skillPath = join(project, ".agents", "skills", "demo", "SKILL.md");
    await writeFile(skillPath, `${await readFile(skillPath, "utf8")}local edit\n`);
    await expect(
      manager.update({
        name: "demo",
        scope: "project",
        projectDirectory: project,
        requestId: "request_update_3",
      }),
    ).rejects.toMatchObject({ code: "LOCALLY_MODIFIED" });
    await expect(
      manager.remove({
        name: "demo",
        scope: "project",
        projectDirectory: project,
        requestId: "request_remove_3",
      }),
    ).rejects.toMatchObject({ code: "LOCALLY_MODIFIED" });
    expect((await manager.list("project", project))[0]).toMatchObject({
      generation: 2,
      modified: true,
    });
  });

  test("publishes and removes a Host-scoped installation without a Project fallback", async () => {
    const { home } = await fixture();
    const manager = new SkillsManager({ homeDirectory: home, resolver: async () => source() });

    const installed = await manager.install({
      source: source().requested,
      scope: "host",
      requestId: "request_host_install",
    });
    expect(installed).toMatchObject({
      scope: "host",
      generation: 1,
      location: join(home, ".agents", "skills", "demo"),
    });

    await manager.remove({
      name: "demo",
      scope: "host",
      requestId: "request_host_remove",
      expectedGeneration: 1,
    });
    expect(await manager.list("host")).toEqual([]);
    expect(
      JSON.parse(await readFile(join(home, ".agents", "skills-lock.json"), "utf8")),
    ).toMatchObject({ generation: 2, skills: {} });
  });

  test("failed validation leaves the old generation and content intact", async () => {
    const { project, home } = await fixture();
    await mkdir(project, { recursive: true });
    let current = source("Good version.");
    const manager = new SkillsManager({ homeDirectory: home, resolver: async () => current });
    await manager.install({
      source: current.requested,
      scope: "project",
      projectDirectory: project,
      requestId: "request_install_4",
    });
    current = {
      ...source("Bad version.", "b".repeat(40)),
      files: [{ path: "SKILL.md", contents: encoder.encode("not a skill") }],
    };
    await expect(
      manager.update({
        name: "demo",
        scope: "project",
        projectDirectory: project,
        requestId: "request_update_4",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SKILL" });
    const listed = await manager.list("project", project);
    expect(listed[0]).toMatchObject({ generation: 1, modified: false, revision: "a".repeat(40) });
    expect(
      await readFile(join(project, ".agents", "skills", "demo", "SKILL.md"), "utf8"),
    ).toContain("Good version.");
  });

  test.each([
    [{ path: "guide", contents: encoder.encode("x"), type: "symlink" as const }, "UNSAFE_FILE"],
    [{ path: "guide", contents: encoder.encode("x"), links: 2 }, "UNSAFE_FILE"],
    [{ path: "Readme.md", contents: encoder.encode("x") }, "PATH_COLLISION"],
  ])("rejects links and case-fold collisions", async (extra, code) => {
    const { project, home } = await fixture();
    await mkdir(project, { recursive: true });
    const unsafe = source();
    unsafe.files.push(
      extra,
      ...(code === "PATH_COLLISION" ? [{ path: "README.md", contents: encoder.encode("y") }] : []),
    );
    const manager = new SkillsManager({ homeDirectory: home, resolver: async () => unsafe });
    await expect(
      manager.install({
        source: unsafe.requested,
        scope: "project",
        projectDirectory: project,
        requestId: `request_${code}`,
      }),
    ).rejects.toMatchObject({ code });
  });

  test("fails closed on a malformed lock and rejects linked installed trees", async () => {
    const { project, home, root } = await fixture();
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "skills-lock.json"), "{broken");
    const manager = new SkillsManager({ homeDirectory: home, resolver: async () => source() });
    await expect(manager.list("project", project)).rejects.toThrow("malformed");

    await rm(join(project, "skills-lock.json"));
    await manager.install({
      source: source().requested,
      scope: "project",
      projectDirectory: project,
      requestId: "request_install_5",
    });
    const target = join(project, ".agents", "skills", "demo", "linked.md");
    await symlink(join(root, "outside"), target);
    expect((await manager.list("project", project))[0]).toMatchObject({ modified: true });
    await rm(target);
    await writeFile(target, "same");
    await link(target, join(project, ".agents", "skills", "demo", "hardlink.md"));
    expect((await manager.list("project", project))[0]).toMatchObject({ modified: true });
  });

  test("ignores an incompatible foreign legacy lock when no OpenGUI lock exists", async () => {
    const { home } = await fixture();
    const skillDirectory = join(home, ".agents", "skills", "demo");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: demo\ndescription: Existing unmanaged skill.\n---\n# Demo\n",
    );
    await writeFile(
      join(home, ".agents", ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          demo: {
            source: "acme/skills",
            sourceType: "github",
            skillPath: "demo/SKILL.md",
          },
        },
      }),
    );
    const manager = new SkillsManager({ homeDirectory: home, resolver: async () => source() });

    await expect(manager.list("host")).resolves.toEqual([
      expect.objectContaining({ name: "demo", managed: false }),
    ]);
  });

  test("does not fall back to HOME when a project is missing", async () => {
    const { home } = await fixture();
    const manager = new SkillsManager({ homeDirectory: home, resolver: async () => source() });
    await expect(
      manager.install({
        source: source().requested,
        scope: "project",
        requestId: "request_missing_project",
      }),
    ).rejects.toMatchObject({ code: "PROJECT_REQUIRED" });
  });
});
