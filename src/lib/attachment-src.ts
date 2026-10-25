// POSIX, Windows drive (`C:\`), and Windows UNC (`\\server\share`) paths.
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function joinPath(baseDirectory: string, path: string): string {
  const normalizedBase = baseDirectory.replace(/[\\/]+$/, "");
  return `${normalizedBase}/${path.replace(/^[\\/]+/, "")}`;
}

function toFileUrl(path: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(path)) return `file:///${path.replace(/\\/g, "/")}`;
  return `file://${path}`;
}

export function resolveAttachmentImageSrc(
  url: string,
  serverUrl?: string | null,
  baseDirectory?: string | null,
): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^(data:|blob:|https?:|file:)/i.test(trimmed)) return trimmed;

  const normalizedServerUrl =
    typeof serverUrl === "string" && serverUrl.trim() ? serverUrl.trim().replace(/\/+$/, "") : null;
  const resolvedPath =
    !isAbsolutePath(trimmed) && baseDirectory ? joinPath(baseDirectory, trimmed) : trimmed;

  if (normalizedServerUrl) {
    const params = new URLSearchParams({ path: resolvedPath });
    if (!isAbsolutePath(trimmed) && baseDirectory) params.set("directory", baseDirectory);
    return `${normalizedServerUrl}/api/fs/file?${params.toString()}`;
  }

  if (isAbsolutePath(resolvedPath)) return toFileUrl(resolvedPath);
  return trimmed;
}

/**
 * Host URL that image previews are fetched from. Desktop Local runs its Host
 * as a sidecar on a per-launch port, so the stored workspace URL (the web
 * default) never reaches it.
 */
export function resolveAttachmentBaseUrl(
  workspace: { isLocal?: boolean; serverUrl?: string } | null | undefined,
  electronApi: { kind?: "electron" | "web"; backendUrl?: string | null } | undefined,
): string | null {
  if (!workspace) return null;
  if (electronApi?.kind === "electron" && workspace.isLocal) return electronApi.backendUrl ?? null;
  return workspace.serverUrl ?? null;
}

/**
 * Bearer credential for image requests. Desktop Local's sidecar trusts its own
 * renderer, and cookie sessions ride along with plain `<img>` requests; only a
 * token-authenticated Remote Host needs an explicit header.
 */
export function resolveAttachmentAuthToken(
  workspace: { isLocal?: boolean; authToken?: string } | null | undefined,
  electronApi: { kind?: "electron" | "web" } | undefined,
): string | null {
  if (!workspace) return null;
  if (electronApi?.kind === "electron" && workspace.isLocal) return null;
  return workspace.authToken?.trim() || null;
}

function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether an image URL points at the Host previews are fetched from. Only
 * these requests may carry the Host bearer credential: a user-typed
 * `@https://…png` mention resolves to its own third-party origin.
 */
export function isAttachmentHostUrl(src: string, baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  const origin = httpOrigin(src);
  return origin !== null && origin === httpOrigin(baseUrl);
}

const IMAGE_FILE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const INLINE_IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

export type MarkdownImageSource = { kind: "path"; path: string } | { kind: "data"; src: string };

/**
 * Classify a model-authored markdown image `src`. Only Host files and inline
 * raster data render; remote URLs stay blocked so transcripts never contact an
 * arbitrary origin.
 */
export function classifyMarkdownImageSource(
  src: string | null | undefined,
): MarkdownImageSource | null {
  const trimmed = src?.trim();
  if (!trimmed) return null;
  if (INLINE_IMAGE_DATA_URL.test(trimmed)) return { kind: "data", src: trimmed };

  // Markdown percent-encodes spaces, non-ASCII, and backslashes in URLs.
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    // Keep the raw value; a malformed escape is still a usable path.
  }

  let path = decoded;
  if (/^file:/i.test(decoded)) {
    path = decoded.replace(/^file:(\/\/[^/]*)?/i, "");
    // file:///C:/dir -> C:/dir
    if (/^\/[a-zA-Z]:[\\/]/.test(path)) path = path.slice(1);
  } else if (!/^[a-zA-Z]:[\\/]/.test(decoded) && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) {
    return null;
  }

  const withoutQuery = path.replace(/[?#].*$/, "");
  if (!IMAGE_FILE_EXTENSION.test(withoutQuery)) return null;
  return { kind: "path", path: withoutQuery };
}
