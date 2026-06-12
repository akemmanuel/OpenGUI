/** Normalize project path for stable workspace/session keys. */
export function normalizeProjectPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (/^[/\\]+$/.test(trimmed)) return trimmed[0] ?? trimmed;
  const windowsDriveRoot = trimmed.match(/^([A-Za-z]:)([/\\]+)$/);
  if (windowsDriveRoot) {
    return `${windowsDriveRoot[1]}${trimmed.includes("\\") ? "\\" : "/"}`;
  }
  return trimmed.replace(/[/\\]+$/, "");
}

/** Extract the trailing directory name from an absolute path (cross-platform). */
export function getProjectName(directory: string, fallback = "repo"): string {
  const parts = normalizeProjectPath(directory).split(/[/\\]/);
  return parts[parts.length - 1] || fallback;
}
