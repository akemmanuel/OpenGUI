import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findFilesInDirectory } from "./file-search.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(files: string[]) {
  const root = await mkdtemp(join(tmpdir(), "opengui-media-mentions-"));
  roots.push(root);
  for (const path of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "image fixture");
  }
  return root;
}

describe("project file mentions", () => {
  test("finds real project images instead of filling suggestions with QA and worktree copies", async () => {
    const root = await project([
      ".opengui-qa/faq-fix/baseline/public/uploads/001-foto.jpg",
      ".opengui-qa/faq-fix/baseline/public/uploads/002-foto.jpg",
      ".opengui-worktrees/layout/public/uploads/003-foto.jpg",
      ".astro/assets/004-foto.jpg",
      "public/media/foto.jpg.webp",
      "src/assets/foto.jpg",
    ]);
    expect(await findFilesInDirectory(root, "jpg", { maxResults: 2 })).toEqual([
      "public/media/foto.jpg.webp",
      "src/assets/foto.jpg",
    ]);
  });

  test("keeps uploaded originals searchable even though Git ignores their folder", async () => {
    const root = await project([
      ".gitignore",
      ".opengui-uploads/media-originals/teamfoto.jpg",
      "public/media/teamfoto.jpg.webp",
    ]);
    await writeFile(join(root, ".gitignore"), ".opengui-uploads/\n");
    expect(await findFilesInDirectory(root, "teamfoto")).toEqual([
      ".opengui-uploads/media-originals/teamfoto.jpg",
      "public/media/teamfoto.jpg.webp",
    ]);
  });

  test("prunes temporary folders nested beneath the requested project", async () => {
    const root = await project([
      "nested/.opengui-qa/baseline/logo.png",
      "nested/.opengui-worktrees/task/logo.png",
      "nested/.astro/logo.png",
      "nested/node_modules/pkg/logo.png",
      "nested/dist/logo.png",
      "nested/.git/logo.png",
      "nested/assets/logo.png",
    ]);
    expect(await findFilesInDirectory(root, "logo")).toEqual(["nested/assets/logo.png"]);
  });
});
