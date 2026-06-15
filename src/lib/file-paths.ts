const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const UNC_PATH_RE = /^\\\\[^\\/]+[\\/][^\\/]+/;
const FILE_EXTENSION_RE = /(^|[\\/])[^\\/<>:"|?*\n\r]+\.[A-Za-z0-9]{1,12}$/;

export function cleanFilePathToken(value: string) {
  return value.trim().replace(/^["']|["']$/g, "");
}

export function isAbsolutePathLike(value: string) {
  return value.startsWith("/") || WINDOWS_ABSOLUTE_PATH_RE.test(value) || UNC_PATH_RE.test(value);
}

export function isFilePathLike(value: string) {
  const cleaned = cleanFilePathToken(value);
  if (!cleaned || cleaned.length > 1024) return false;
  if (cleaned.includes("\n") || cleaned.includes("\r") || cleaned.includes("\u0000")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned) && !WINDOWS_ABSOLUTE_PATH_RE.test(cleaned)) return false;
  if (!cleaned.includes("/") && !cleaned.includes("\\")) return false;
  if (!FILE_EXTENSION_RE.test(cleaned)) return false;
  if (/^[-–—]/.test(cleaned)) return false;
  return true;
}
