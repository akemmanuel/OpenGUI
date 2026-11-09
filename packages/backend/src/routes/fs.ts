import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { BackendApp } from "../http/request-context.ts";
import { findFilesInDirectory } from "../../../../server/services/file-search.ts";
import { isWithinAllowedRoot } from "../host/path-safety.ts";
import { jsonError } from "../http/json.ts";
import { contentTypeForPath } from "../transport/static-host.ts";
import type { BackendHostEnv } from "../host/env.ts";
import { durableActor } from "../identity/types.ts";
import { HostPathAuthorizer, PathAuthorizationError } from "../path-policy/enforcement.ts";

export type FsRouteDeps = {
  env: Pick<
    BackendHostEnv,
    "allowedRoots" | "uploadMaxFileBytes" | "uploadMaxBatchBytes" | "downloadMaxBytes"
  >;
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>;
  pathAuthorizer: HostPathAuthorizer;
};

/**
 * Transcripts request every referenced image on render, and the response is
 * read into memory. Larger files are not shown as previews.
 */
export const MAX_FILE_PREVIEW_BYTES = 25 * 1024 * 1024;

/** Bytes read to decide whether a file is text. */
const TEXT_SNIFF_BYTES = 8192;

/** Text encoding of a file, or null when it is binary. */
export type TextEncodingGuess = "utf-8" | "windows-1252" | null;

// Control characters other than tab, line breaks, form feed and escape do
// not occur in text files.
const hasBinaryControl = (bytes: Uint8Array) =>
  bytes.some((byte) => byte < 32 && ![9, 10, 11, 12, 13, 27].includes(byte));

export function guessTextEncoding(bytes: Uint8Array): TextEncodingGuess {
  if (hasBinaryControl(bytes)) return null;
  try {
    // `stream` keeps a multi-byte character cut off by the sniff window from failing.
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return "utf-8";
  } catch {
    // Legacy single-byte text (umlauts in Latin-1 / Windows-1252) is still text.
    return "windows-1252";
  }
}

async function readFileHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function attachmentDisposition(name: string) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Agent-written files, including SVG and HTML, must never run script with the
// Host's origin when a response is opened directly.
const UNTRUSTED_FILE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  // Agents overwrite files in place; always revalidate.
  "cache-control": "no-cache",
};

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

type ListedEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
  /** Only when files are listed. */
  size?: number;
  modifiedAt?: number;
};

async function listServerDirectories(
  path: string,
  roots: string[],
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>,
  authorizeRead: (path: string) => Promise<string>,
  includeFiles = false,
) {
  const directory = await resolveSafeDirectory(path);
  const entries = await readdir(directory, { withFileTypes: true });
  const visibleEntries = await Promise.all(
    entries
      .filter(
        (entry) =>
          (entry.isDirectory() || (includeFiles && entry.isFile())) &&
          !entry.isSymbolicLink() &&
          !entry.name.startsWith("."),
      )
      .map(async (entry): Promise<ListedEntry | null> => {
        const entryPath = join(directory, entry.name);
        try {
          const listed: ListedEntry = {
            name: entry.name,
            path: await authorizeRead(entryPath),
            type: entry.isDirectory() ? "dir" : "file",
          };
          if (includeFiles) {
            const info = await stat(entryPath);
            if (listed.type === "file") listed.size = info.size;
            listed.modifiedAt = info.mtimeMs;
          }
          return listed;
        } catch (error) {
          if (error instanceof PathAuthorizationError) return null;
          // Deleted between readdir and stat.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      }),
  );
  const dirs = visibleEntries
    .filter((entry) => entry !== null)
    .sort(
      (a, b) =>
        Number(a.type === "file") - Number(b.type === "file") ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
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
        value: await listServerDirectories(
          authorized,
          roots,
          deps.resolveSafeDirectory,
          (path) => deps.pathAuthorizer.authorizePath(actor, path, "read"),
          c.req.query("files") === "1",
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

  /**
   * Resolve a requested file the actor may read. Relative paths resolve
   * against `directory` (a Project), absolute ones are used as they are.
   */
  async function resolveReadableFile(
    actor: ReturnType<typeof durableActor>,
    inputPath: string | undefined,
    directory: string | null,
  ) {
    if (!inputPath) throw new Error("path is required");
    // `isAbsolute` follows the Host platform, so Windows drive and UNC paths
    // are not mistaken for Project-relative paths.
    const requestedPath = isAbsolute(inputPath)
      ? inputPath
      : join(
          await deps.pathAuthorizer.authorizePath(
            actor,
            resolve(directory || deps.env.allowedRoots[0]!),
            "read",
          ),
          inputPath,
        );
    const authorized = await deps.pathAuthorizer.authorizePath(actor, requestedPath, "read");
    const actual = await realpath(authorized);
    const allowed = isWithinAllowedRoot(actual, deps.env.allowedRoots);
    if (!allowed) throw new Error("Path outside OPENGUI_ALLOWED_ROOTS");
    const info = await stat(actual);
    if (!info.isFile()) throw new Error("Path is not a file");
    return { authorized, actual, info };
  }

  app.get("/api/fs/stat", async (c) => {
    try {
      const { authorized, actual, info } = await resolveReadableFile(
        durableActor(c.get("actor")),
        c.req.query("path")?.trim(),
        c.req.query("directory")?.trim() || null,
      );
      const head = await readFileHead(actual, Math.min(info.size, TEXT_SNIFF_BYTES));
      return Response.json({
        ok: true,
        value: {
          path: authorized,
          name: basename(authorized),
          size: info.size,
          modifiedAt: info.mtimeMs,
          textEncoding: guessTextEncoding(head),
        },
      });
    } catch (error) {
      return fsError(error);
    }
  });

  app.get("/api/fs/file", async (c) => {
    try {
      const { actual, info } = await resolveReadableFile(
        durableActor(c.get("actor")),
        c.req.query("path")?.trim(),
        c.req.query("directory")?.trim() || null,
      );

      if (c.req.query("download") === "1") {
        const limit = deps.env.downloadMaxBytes ?? 0;
        if (limit > 0 && info.size > limit)
          return jsonError(new Error("File exceeds download size limit"), 413);
        // Streamed, so the file size does not matter to the Host's memory.
        const body = Readable.toWeb(createReadStream(actual)) as ReadableStream<Uint8Array>;
        return new Response(body, {
          headers: {
            ...UNTRUSTED_FILE_HEADERS,
            "content-type": "application/octet-stream",
            "content-length": String(info.size),
            "content-disposition": attachmentDisposition(basename(actual)),
          },
        });
      }

      // Text previews only need the beginning of a large file.
      const maxBytes = Number(c.req.query("maxBytes"));
      if (Number.isInteger(maxBytes) && maxBytes > 0) {
        const length = Math.min(info.size, maxBytes, MAX_FILE_PREVIEW_BYTES);
        return new Response(await readFileHead(actual, length), {
          headers: { ...UNTRUSTED_FILE_HEADERS, "content-type": contentTypeForPath(actual) },
        });
      }

      // pdf.js reads ranges as pages are needed, without buffering the entire
      // document on either the Host or the client.
      if (extname(actual).toLowerCase() === ".pdf") {
        const headers: Record<string, string> = {
          ...UNTRUSTED_FILE_HEADERS,
          "content-type": "application/pdf",
          "accept-ranges": "bytes",
        };
        const range = c.req.header("range");
        let start = 0;
        let end = info.size - 1;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2])) {
            return new Response(null, {
              status: 416,
              headers: { ...headers, "content-range": `bytes */${info.size}` },
            });
          }
          start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start > end ||
            start >= info.size
          ) {
            return new Response(null, {
              status: 416,
              headers: { ...headers, "content-range": `bytes */${info.size}` },
            });
          }
          headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
        }
        headers["content-length"] = String(Math.max(0, end - start + 1));
        const body =
          info.size === 0
            ? null
            : (Readable.toWeb(
                createReadStream(actual, { start, end }),
              ) as ReadableStream<Uint8Array>);
        return new Response(body, { status: range ? 206 : 200, headers });
      }

      if (info.size > MAX_FILE_PREVIEW_BYTES)
        return jsonError(new Error("File exceeds preview size limit"), 413);
      return new Response(await readFile(actual), {
        headers: { ...UNTRUSTED_FILE_HEADERS, "content-type": contentTypeForPath(actual) },
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
