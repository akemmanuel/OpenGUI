import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { BackendApp } from "../http/request-context.ts";
import { findFilesInDirectory } from "../../../../server/services/file-search.ts";
import { isWithinAllowedRoot } from "../host/path-safety.ts";
import { jsonError } from "../http/json.ts";
import { contentTypeForPath } from "../transport/static-host.ts";
import type { BackendHostEnv } from "../host/env.ts";
import { durableActor } from "../identity/types.ts";
import { HostPathAuthorizer, PathAuthorizationError } from "../path-policy/enforcement.ts";

export type FsRouteDeps = {
  env: Pick<BackendHostEnv, "allowedRoots" | "uploadMaxFileBytes" | "uploadMaxBatchBytes">;
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>;
  pathAuthorizer: HostPathAuthorizer;
};

/**
 * Transcripts request every referenced image on render, and the response is
 * read into memory. Larger files are not shown as previews.
 */
export const MAX_FILE_PREVIEW_BYTES = 25 * 1024 * 1024;

function fsError(error: unknown) {
  return jsonError(error, error instanceof PathAuthorizationError ? 403 : 400);
}

// Keep pasted screenshots out of the user's repository without touching their
// own .gitignore.
async function ensureUploadsIgnored(dir: string) {
  try {
    await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function listServerDirectories(
  path: string,
  roots: string[],
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>,
  authorizeRead: (path: string) => Promise<string>,
) {
  const directory = await resolveSafeDirectory(path);
  const entries = await readdir(directory, { withFileTypes: true });
  const visibleEntries = await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."),
      )
      .map(async (entry) => {
        const entryPath = join(directory, entry.name);
        try {
          return {
            name: entry.name,
            path: await authorizeRead(entryPath),
            type: "dir" as const,
          };
        } catch (error) {
          if (error instanceof PathAuthorizationError) return null;
          throw error;
        }
      }),
  );
  const dirs = visibleEntries
    .filter((entry) => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  let authorizedParent: string | null = null;
  if (roots.some((root) => isWithinAllowedRoot(parent, [root]))) {
    try {
      authorizedParent = await authorizeRead(parent);
    } catch (error) {
      if (!(error instanceof PathAuthorizationError)) throw error;
    }
  }
  return { path: directory, parent: authorizedParent, roots, entries: dirs };
}

async function effectiveRoots(
  policy: Awaited<ReturnType<HostPathAuthorizer["policy"]>>,
  allowedRoots: string[],
) {
  if (policy?.restricted !== true) return allowedRoots;
  const roots = await Promise.all(
    (policy.grants ?? []).map(async (grant) =>
      (await policy.authorizePath(grant.root, "read")).allowed ? grant.root : null,
    ),
  );
  return [...new Set(roots.filter((root): root is string => root !== null))];
}

export function registerFsRoutes(app: BackendApp, deps: FsRouteDeps) {
  app.get("/api/fs/list", async (c) => {
    try {
      const actor = durableActor(c.get("actor"));
      const policy = await deps.pathAuthorizer.policy(actor);
      const roots = await effectiveRoots(policy, deps.env.allowedRoots);
      const fallback = roots[0];
      if (!fallback) throw new PathAuthorizationError();
      const requested = resolve(c.req.query("path")?.trim() || fallback);
      const authorized = await deps.pathAuthorizer.authorizePath(actor, requested, "read");
      return Response.json({
        ok: true,
        value: await listServerDirectories(authorized, roots, deps.resolveSafeDirectory, (path) =>
          deps.pathAuthorizer.authorizePath(actor, path, "read"),
        ),
      });
    } catch (error) {
      return fsError(error);
    }
  });

  app.get("/api/fs/roots", async (c) => {
    try {
      const policy = await deps.pathAuthorizer.policy(durableActor(c.get("actor")));
      const roots = await effectiveRoots(policy, deps.env.allowedRoots);
      return Response.json({ ok: true, value: roots });
    } catch (error) {
      return fsError(error);
    }
  });

  app.get("/api/fs/file", async (c) => {
    try {
      const inputPath = c.req.query("path")?.trim();
      if (!inputPath) throw new Error("path is required");
      const directory = c.req.query("directory")?.trim() || null;
      // `isAbsolute` follows the Host platform, so Windows drive and UNC paths
      // are not mistaken for Project-relative paths.
      const requestedPath = isAbsolute(inputPath)
        ? inputPath
        : join(
            await deps.pathAuthorizer.authorizePath(
              durableActor(c.get("actor")),
              resolve(directory || deps.env.allowedRoots[0]!),
              "read",
            ),
            inputPath,
          );
      const authorized = await deps.pathAuthorizer.authorizePath(
        durableActor(c.get("actor")),
        requestedPath,
        "read",
      );
      const actual = await realpath(authorized);
      const allowed = isWithinAllowedRoot(actual, deps.env.allowedRoots);
      if (!allowed) throw new Error("Path outside OPENGUI_ALLOWED_ROOTS");
      const info = await stat(actual);
      if (!info.isFile()) throw new Error("Path is not a file");
      if (info.size > MAX_FILE_PREVIEW_BYTES)
        return jsonError(new Error("File exceeds preview size limit"), 413);
      return new Response(await readFile(actual), {
        headers: {
          "content-type": contentTypeForPath(actual),
          // Transcripts render agent-written files, including SVG. Opened
          // directly, they must never run script with the Host's origin.
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          // Agents overwrite images in place; always revalidate.
          "cache-control": "no-cache",
        },
      });
    } catch (error) {
      return fsError(error);
    }
  });

  app.get("/api/fs/search", async (c) => {
    try {
      const directoryParam =
        c.req.query("directory")?.trim() || c.req.query("projectId")?.trim() || "";
      const query = c.req.query("query") ?? "";
      const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
      if (!directoryParam) throw new Error("directory is required");
      const requested = resolve(directoryParam);
      const authorized = await deps.pathAuthorizer.authorizePath(
        durableActor(c.get("actor")),
        requested,
        "read",
      );
      const searchDirectory = await deps.resolveSafeDirectory(authorized);
      const files = await findFilesInDirectory(searchDirectory, query);
      return Response.json({ ok: true, value: files.slice(0, limit) });
    } catch (error) {
      return fsError(error);
    }
  });

  app.post("/api/fs/upload", async (c) => {
    try {
      const actor = durableActor(c.get("actor"));
      const restricted = await deps.pathAuthorizer.isRestricted(actor);
      const form = await c.req.raw.formData();
      const files = form.getAll("files").filter((value): value is File => value instanceof File);
      if (files.length === 0) throw new Error("At least one file is required");
      const totalSize = files.reduce((sum, file) => sum + file.size, 0);
      if (totalSize > deps.env.uploadMaxBatchBytes)
        throw new Error("Upload batch exceeds size limit");
      for (const file of files) {
        if (file.size > deps.env.uploadMaxFileBytes) throw new Error("File exceeds size limit");
      }

      const directoryValue = form.get("directory");
      const directory = typeof directoryValue === "string" ? directoryValue.trim() : "";
      if (restricted && !directory) throw new Error("directory is required");
      // Project uploads must outlive the OS temp dir and stay inside allowed
      // roots, so transcripts can still render them through /api/fs/file.
      const projectScoped = Boolean(directory);

      let dir: string;
      if (projectScoped) {
        const destination = await deps.pathAuthorizer.authorizePath(
          actor,
          resolve(directory),
          "write",
        );
        await deps.resolveSafeDirectory(destination);
        dir = await deps.pathAuthorizer.authorizePath(
          actor,
          join(destination, ".opengui-uploads"),
          "write",
          { allowMissingLeaf: true },
        );
      } else {
        dir = join(tmpdir(), "opengui-uploads");
      }
      await mkdir(dir, { recursive: true });
      if (projectScoped) await ensureUploadsIgnored(dir);

      const uploaded: string[] = [];
      for (const file of files) {
        const originalName = typeof file.name === "string" ? basename(file.name) : "file";
        const extension = extname(originalName)
          .replace(/[^a-zA-Z0-9.]/g, "")
          .slice(0, 24);
        const requestedFilePath = join(dir, `${randomUUID()}${extension}`);
        const filePath = projectScoped
          ? await deps.pathAuthorizer.authorizePath(actor, requestedFilePath, "write", {
              allowMissingLeaf: true,
            })
          : requestedFilePath;
        await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
        uploaded.push(filePath);
      }

      return Response.json({ ok: true, value: uploaded });
    } catch (error) {
      return fsError(error);
    }
  });
}
