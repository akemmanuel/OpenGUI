import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { seeded } from "../test/seeded.ts";
import { containsPath, createEffectivePathPolicy } from "./path-policy.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true }))));

describe("seeded path-policy properties", () => {
  test("containsPath agrees with node:path containment for 2,000 normalized boundaries", () => {
    const random = seeded(0x50415448);
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const root = resolve("/tmp", `root-${random.int(0, 20)}`);
      const segments = Array.from({ length: random.int(0, 7) }, () =>
        random.pick(["child", ".", "..", `node-${random.int(0, 9)}`]),
      );
      const candidate = resolve(root, ...segments);
      const fromRoot = relative(root, candidate);
      const expected =
        fromRoot === "" ||
        (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
      expect(containsPath(root, candidate), `${iteration}: ${root} -> ${candidate}`).toBe(expected);
    }
  });

  test("restricted authorization never crosses grants through traversal, sibling prefixes, or symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-path-property-"));
    cleanup.push(root);
    const grant = join(root, "grant");
    const sibling = join(root, "grant-sibling");
    await mkdir(grant);
    await mkdir(sibling);
    await writeFile(join(grant, "inside.txt"), "ok");
    await writeFile(join(sibling, "outside.txt"), "no");
    await symlink(sibling, join(grant, "escape"), "dir");
    const policy = createEffectivePathPolicy({
      revision: 1,
      restricted: true,
      allowedRoots: [root],
      grants: [{ root: grant, access: "write" }],
    });
    const random = seeded(0x53414645);
    const safe = [join(grant, "inside.txt"), join(grant, "missing", "new.txt")];
    const unsafe = [
      join(sibling, "outside.txt"),
      join(grant, "..", "grant-sibling", "outside.txt"),
      join(grant, "escape", "outside.txt"),
    ];
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const shouldAllow = random.int(0, 1) === 1;
      const candidate = random.pick(shouldAllow ? safe : unsafe);
      const decision = await policy.authorizePath(candidate, "write", { allowMissingLeaf: true });
      expect(decision.allowed, `${iteration}: ${candidate}`).toBe(shouldAllow);
      if (decision.allowed) expect(containsPath(grant, decision.canonicalPath!)).toBe(true);
    }
  });
});
