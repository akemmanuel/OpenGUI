import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicWriteFile(path: string, content: string, createParents: boolean) {
  const parent = dirname(path);
  if (createParents) await mkdir(parent, { recursive: true });
  const temporaryPath = `${path}.opengui-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
