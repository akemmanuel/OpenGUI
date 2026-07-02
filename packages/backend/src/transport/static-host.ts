import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function contentTypeForPath(filePath: string) {
  return contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export async function serveBuiltFile(request: Request) {
  const url = new URL(request.url);
  const requestedPath = decodeURIComponent(url.pathname);
  const safePath = requestedPath.includes("..") ? "/index.html" : requestedPath;
  const distPath = resolve("dist", safePath === "/" ? "index.html" : safePath.slice(1));
  const distRoot = resolve("dist");
  const filePath =
    distPath.startsWith(distRoot) && existsSync(distPath) ? distPath : join(distRoot, "index.html");
  return new Response(await readFile(filePath), {
    headers: { "content-type": contentTypeForPath(filePath) },
  });
}

export async function serveDevIndex() {
  const filePath = resolve("src", "index.html");
  return new Response(await readFile(filePath), {
    headers: { "content-type": contentTypeForPath(filePath) },
  });
}
