function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
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
