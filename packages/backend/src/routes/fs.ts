import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { Hono } from "hono";
import { findFilesInDirectory } from "../../../../server/services/index.ts";
import { isWithinAllowedRoot } from "@opengui/runtime";
import { jsonError } from "../http/json.ts";
import { contentTypeForPath } from "../transport/static-host.ts";
import type { BackendHostEnv } from "../host/env.ts";

export type FsRouteDeps = {
  env: Pick<BackendHostEnv, "allowedRoots" | "uploadMaxFileBytes" | "uploadMaxBatchBytes">;
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>;
  resolveHarnessDirectoryForSessions: (input: {
    directory: string;
  }) => Promise<{ directory: string; canonicalPath: string }>;
};

async function listServerDirectories(
  inputPath: string | null,
  allowedRoots: string[],
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>,
) {
  const path = await resolveSafeDirectory(inputPath);
  const entries = await readdir(path, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name), type: "dir" as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  const canGoUp = isWithinAllowedRoot(parent, allowedRoots);
  return { path, parent: canGoUp ? parent : null, roots: allowedRoots, entries: dirs };
}

export function registerFsRoutes(app: Hono, deps: FsRouteDeps) {
  app.get("/api/fs/list", async (c) => {
    try {
      return Response.json({
        ok: true,
        value: await listServerDirectories(
          c.req.query("path") ?? null,
          deps.env.allowedRoots,
          deps.resolveSafeDirectory,
        ),
      });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.get("/api/fs/roots", () => Response.json({ ok: true, value: deps.env.allowedRoots }));

  app.get("/api/fs/file", async (c) => {
    try {
      const inputPath = c.req.query("path")?.trim();
      if (!inputPath) throw new Error("path is required");
      const directory = c.req.query("directory")?.trim() || null;
      const requestedPath = inputPath.startsWith("/")
        ? inputPath
        : join(await deps.resolveSafeDirectory(directory), inputPath);
      const actual = await realpath(requestedPath);
      const allowed = deps.env.allowedRoots.some(
        (root) => actual === root || actual.startsWith(`${root}/`),
      );
      if (!allowed) throw new Error("Path outside OPENGUI_ALLOWED_ROOTS");
      const info = await stat(actual);
      if (!info.isFile()) throw new Error("Path is not a file");
      return new Response(await readFile(actual), {
        headers: {
          "content-type": contentTypeForPath(actual),
        },
      });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.get("/api/fs/search", async (c) => {
    try {
      const directoryParam =
        c.req.query("directory")?.trim() || c.req.query("projectId")?.trim() || "";
      const query = c.req.query("query") ?? "";
      const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
      if (!directoryParam) throw new Error("directory is required");
      const searchDirectory = (
        await deps.resolveHarnessDirectoryForSessions({ directory: directoryParam })
      ).canonicalPath;
      const files = await findFilesInDirectory(searchDirectory, query);
      return Response.json({ ok: true, value: files.slice(0, limit) });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.post("/api/fs/upload", async (c) => {
    try {
      const form = await c.req.raw.formData();
      const files = form.getAll("files").filter((value): value is File => value instanceof File);
      if (files.length === 0) throw new Error("At least one file is required");
      const totalSize = files.reduce((sum, file) => sum + file.size, 0);
      if (totalSize > deps.env.uploadMaxBatchBytes)
        throw new Error("Upload batch exceeds size limit");
      for (const file of files) {
        if (file.size > deps.env.uploadMaxFileBytes) throw new Error("File exceeds size limit");
      }

      const dir = join(tmpdir(), "opengui-uploads");
      await mkdir(dir, { recursive: true });

      const uploaded: string[] = [];
      for (const file of files) {
        const originalName = typeof file.name === "string" ? basename(file.name) : "file";
        const extension = extname(originalName)
          .replace(/[^a-zA-Z0-9.]/g, "")
          .slice(0, 24);
        const filePath = join(dir, `${randomUUID()}${extension}`);
        await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
        uploaded.push(filePath);
      }

      return Response.json({ ok: true, value: uploaded });
    } catch (error) {
      return jsonError(error, 400);
    }
  });
}
