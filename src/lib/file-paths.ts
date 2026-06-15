const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const UNC_PATH_RE = /^\\\\[^\\/]+[\\/][^\\/]+/;
const FILE_EXTENSION_RE = /(^|[\\/])[^\\/<>:"|?*\n\r]*\.[A-Za-z0-9]{1,12}$/;
const EXTENSIONLESS_FILE_NAMES = new Set([
  "Brewfile",
  "Dockerfile",
  "Gemfile",
  "Justfile",
  "Makefile",
  "Procfile",
  "Rakefile",
  "README",
  "Vagrantfile",
]);

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

  const segments = cleaned.split(/[\\/]+/);
  const basename = segments.at(-1) ?? "";
  const hasSeparator = cleaned.includes("/") || cleaned.includes("\\");
  const isDotfile = basename.startsWith(".") && basename.length > 1;
  const hasExtension = FILE_EXTENSION_RE.test(cleaned);
  const isKnownExtensionlessFile = EXTENSIONLESS_FILE_NAMES.has(basename);

  if (!hasSeparator && !isDotfile && !isKnownExtensionlessFile && !hasExtension) return false;
  if (!basename || basename === "." || basename === "..") return false;
  if (!hasExtension && !isDotfile && !isKnownExtensionlessFile && !isAbsolutePathLike(cleaned)) {
    return false;
  }
  // Avoid treating command-line flags in terminal output as relative file paths.
  if (/^[-–—]/.test(cleaned)) return false;
  return true;
}
