import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { canonicalizeGrantRoot, containsPath, createEffectivePathPolicy } from "./path-policy.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opengui-path-policy-"));
  temporaryDirectories.push(root);
  const granted = join(root, "granted");
  const outside = join(root, "outside");
  await Promise.all([mkdir(granted), mkdir(outside)]);
  await writeFile(join(granted, "file.txt"), "safe");
  return { root, granted, outside };
}

describe("path policy", () => {
  test("uses segment-aware canonical containment", async () => {
    const { root, granted, outside } = await fixture();
    expect(containsPath(root, granted)).toBe(true);
    expect(containsPath(granted, `${granted}-sibling`)).toBe(false);
    await expect(canonicalizeGrantRoot(granted, [root])).resolves.toBe(granted);
    await expect(canonicalizeGrantRoot(root, [outside])).rejects.toThrow(
      "outside OPENGUI_ALLOWED_ROOTS",
    );
  });

  test("write grants imply read while read grants do not imply write", async () => {
    const { root, granted } = await fixture();
    const readOnly = createEffectivePathPolicy({
      revision: 1,
      restricted: true,
      allowedRoots: [root],
      grants: [{ root: granted, access: "read" }],
    });
    expect((await readOnly.authorizePath(join(granted, "file.txt"), "read")).allowed).toBe(true);
    expect((await readOnly.authorizePath(join(granted, "file.txt"), "write")).allowed).toBe(false);

    const writable = createEffectivePathPolicy({
      revision: 2,
      restricted: true,
      allowedRoots: [root],
      grants: [{ root: granted, access: "write" }],
    });
    expect((await writable.authorizePath(join(granted, "file.txt"), "read")).allowed).toBe(true);
    expect(
      (
        await writable.authorizePath(join(granted, "new", "file.txt"), "write", {
          allowMissingLeaf: true,
        })
      ).allowed,
    ).toBe(true);
    expect(writable.shellAllowed).toBe(false);
  });

  test("restricted policies reject symlink traversal even when the target stays in a grant", async () => {
    const { root, granted, outside } = await fixture();
    await symlink(outside, join(granted, "link"), "dir");
    const policy = createEffectivePathPolicy({
      revision: 1,
      restricted: true,
      allowedRoots: [root],
      grants: [{ root: granted, access: "write" }],
    });
    expect(await policy.authorizePath(join(granted, "link", "file.txt"), "read")).toMatchObject({
      allowed: false,
      reason: "symlink_traversal",
    });
  });

  test("revalidates the stored grant root on every authorization", async () => {
    const { root, granted } = await fixture();
    const policy = createEffectivePathPolicy({
      revision: 1,
      restricted: true,
      allowedRoots: [root],
      grants: [{ root: granted, access: "write" }],
    });
    expect((await policy.authorizePath(granted, "read")).allowed).toBe(true);

    const movedGrant = join(root, "moved-grant");
    await rename(granted, movedGrant);
    await symlink(movedGrant, granted, "dir");

    expect(await policy.authorizePath(granted, "read")).toMatchObject({
      allowed: false,
      reason: "symlink_traversal",
    });
    expect(await policy.authorizePath(join(granted, "file.txt"), "read")).toMatchObject({
      allowed: false,
      reason: "symlink_traversal",
    });
  });

  test("denies a grant when an ancestor beneath the allowed root is replaced by a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-path-policy-ancestor-"));
    temporaryDirectories.push(root);
    const parent = join(root, "parent");
    const granted = join(parent, "granted");
    await mkdir(granted, { recursive: true });
    const policy = createEffectivePathPolicy({
      revision: 1,
      restricted: true,
      allowedRoots: [root],
      grants: [{ root: granted, access: "read" }],
    });

    const movedParent = join(root, "moved-parent");
    await rename(parent, movedParent);
    await symlink(movedParent, parent, "dir");

    expect(await policy.authorizePath(granted, "read")).toMatchObject({
      allowed: false,
      reason: "symlink_traversal",
    });
  });

  test("unrestricted policies remain bounded only by global roots", async () => {
    const { root, granted } = await fixture();
    const policy = createEffectivePathPolicy({
      revision: 0,
      restricted: false,
      allowedRoots: [root],
      grants: [],
    });
    expect((await policy.authorizePath(join(granted, "missing"), "read")).allowed).toBe(false);
    expect(policy.shellAllowed).toBe(true);
  });
});
