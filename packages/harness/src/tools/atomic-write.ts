import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicWriteFile(path: string, content: string, createParents: boolean) {
  const parent = dirname(path);
  if (createParents) await mkdir(parent, { recursive: true });
  const temporaryPath = `${path}.opengui-${randomUUID()}.tmp`;
  try {
    const existingMode = await stat(path).then(
      (metadata) => metadata.mode,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    await writeFile(temporaryPath, content, "utf8");
    if (existingMode !== undefined) await chmod(temporaryPath, existingMode);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
