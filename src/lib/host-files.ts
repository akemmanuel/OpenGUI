/**
 * Helpers for the Files panel: Host paths, file links in model output, preview
 * kinds, and the files a chat's tool calls created or changed.
 */
import { extractEditFiles } from "@/components/message-list/tools/applyPatch";
import { normalizeKind } from "@/components/message-list/tools/toolCallModel";
import { getToolInput, stringField } from "@/components/message-list/tools/toolCallUtils";
import type { TranscriptMessageEntry } from "@/protocol/session-transcript";

// ---------------------------------------------------------------------------
// Host paths (POSIX, Windows drive, or UNC; the Host decides which)
// ---------------------------------------------------------------------------

export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function separatorOf(path: string): "/" | "\\" {
  return !path.startsWith("/") && path.includes("\\") ? "\\" : "/";
}

function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return path.slice(0, 1);
  // Keep a drive root such as `C:\`.
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}${separatorOf(path)}` : trimmed;
}

export function joinHostPath(directory: string, relative: string): string {
  const separator = separatorOf(directory);
  const unc = directory.startsWith("\\\\") || directory.startsWith("//");
  const rooted = directory.startsWith("/") || unc;
  const stack = trimTrailingSeparators(directory)
    .split(/[\\/]+/)
    .filter(Boolean);
  const floor = unc ? 2 : /^[a-zA-Z]:$/.test(stack[0] ?? "") ? 1 : 0;
  for (const part of relative.split(/[\\/]+/).filter(Boolean)) {
    if (part === ".") continue;
    if (part === "..") {
      if (stack.length > floor) stack.pop();
    } else stack.push(part);
  }
  const prefix = unc ? separator.repeat(2) : rooted ? separator : "";
  return prefix + stack.join(separator) || separator;
}

/** Resolve a path a model or tool wrote, relative to a Project directory. */
export function resolveHostPath(path: string, baseDirectory: string | null): string | null {
  if (isAbsoluteHostPath(path)) return trimTrailingSeparators(path);
  if (!baseDirectory) return null;
  return joinHostPath(baseDirectory, path);
}

export function hostBasename(path: string): string {
  const trimmed = trimTrailingSeparators(path);
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

export function hostParent(path: string): string {
  const trimmed = trimTrailingSeparators(path);
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index <= 0) return trimmed.startsWith("/") ? "/" : trimmed;
  const parent = trimmed.slice(0, index);
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}${separatorOf(trimmed)}` : parent;
}

function comparable(path: string): string {
  return trimTrailingSeparators(path).replace(/\\/g, "/");
}

export function isWithinHostPath(root: string, path: string): boolean {
  const normalizedRoot = comparable(root);
  const normalizedPath = comparable(path);
  if (normalizedPath === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix);
}

/** Path below `root` using `/`, or null when `path` is outside it. "" is the root itself. */
export function relativeHostPath(root: string, path: string): string | null {
  if (!isWithinHostPath(root, path)) return null;
  const normalizedRoot = comparable(root);
  const rest = comparable(path).slice(normalizedRoot.length);
  return rest.replace(/^\/+/, "");
}

export function sameHostPath(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

// ---------------------------------------------------------------------------
// File links in model-authored markdown
// ---------------------------------------------------------------------------

export type FileLinkTarget = { path: string; line: number | null };

const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

/**
 * Read a markdown link target as a Host file path, e.g. `/abs/x.pdf`,
 * `./src/a.ts:12`, `file:///C:/x.txt`, or `src/a.ts#L4`. Web URLs, mail
 * links, and in-page anchors are not file links.
 */
export function parseFileLink(href: string | null | undefined): FileLinkTarget | null {
  let value = href?.trim();
  if (!value || value.startsWith("#") || value.startsWith("//") || /^www\./i.test(value))
    return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    // A malformed escape is still a usable path.
  }

  if (/^file:/i.test(value)) {
    const host = /^file:\/\/([^/]+)/i.exec(value)?.[1];
    value = value.replace(/^file:(\/\/[^/]*)?/i, "");
    if (host && host.toLowerCase() !== "localhost") value = `//${host}${value}`;
    // file:///C:/dir -> C:/dir
    if (/^\/[a-zA-Z]:[\\/]/.test(value)) value = value.slice(1);
  }

  let line: number | null = null;
  const anchorLine = /#L(\d+)(?:-L?\d+)?$/i.exec(value);
  if (anchorLine) {
    line = Number(anchorLine[1]);
    value = value.slice(0, anchorLine.index);
  } else {
    // `page.html#section` or `page.html?v=2` still opens the file itself.
    const suffix = /[?#][^\\/]*$/.exec(value);
    if (suffix && /\.[a-zA-Z0-9]{1,10}$/.test(value.slice(0, suffix.index)))
      value = value.slice(0, suffix.index);
    const suffixLine = /:(\d+)(?::\d+)?$/.exec(value);
    if (suffixLine) {
      line = Number(suffixLine[1]);
      value = value.slice(0, suffixLine.index);
    }
  }

  if (!WINDOWS_DRIVE.test(value) && URL_SCHEME.test(value)) return null;

  // A bare word such as `[docs](setup)` is more likely a broken web link than a file.
  const looksLikePath = /[\\/]/.test(value) || /\.[a-zA-Z0-9]{1,10}$/.test(value);
  if (!value || !looksLikePath) return null;
  return { path: value, line: line && line > 0 ? line : null };
}

/**
 * CommonMark ends a link target at the first space, so `[PDF](/a b/x.pdf)`
 * renders as raw text. Wrap local path targets that contain spaces in `<…>`.
 */
export function wrapLocalLinkTargetsWithSpaces(markdown: string): string {
  if (!markdown.includes("](")) return markdown;
  return markdown
    .split(
      /(^ {0,3}`{3,}[^\n]*\n[\s\S]*?^ {0,3}`{3,}[ \t]*$|^ {0,3}~{3,}[^\n]*\n[\s\S]*?^ {0,3}~{3,}[ \t]*$|`+[^`\n]*`+)/m,
    )
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(
            /\]\(((?:\/|~\/|\.{1,2}\/|[a-zA-Z]:[\\/]|file:\/\/)[^()<>\n]*? [^()<>\n]*?)\)/g,
            (_match, target: string) => `](<${target}>)`,
          ),
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Preview kinds
// ---------------------------------------------------------------------------

export type TextEncodingGuess = "utf-8" | "windows-1252" | null;
export type PreviewKind = "image" | "pdf" | "html" | "markdown" | "csv" | "text" | "none";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);

export function fileExtension(name: string): string {
  const match = /\.([^.\\/]+)$/.exec(name);
  return match ? match[1]!.toLowerCase() : "";
}

export function previewKindFor(name: string, textEncoding: TextEncodingGuess): PreviewKind {
  const extension = fileExtension(name);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (!textEncoding) return "none";
  if (extension === "csv") return "csv";
  if (extension === "svg" || extension === "html" || extension === "htm") return "html";
  if (extension === "md" || extension === "markdown" || extension === "mdx") return "markdown";
  return "text";
}

/** Text previews stop after this many bytes; the rest is a download away. */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Above this size, text is shown without syntax highlighting. */
export const HIGHLIGHT_MAX_CHARS = 200_000;

/**
 * Keep model-written HTML from loading anything: no network, no frames. The
 * iframe sandbox already stops scripts; this also stops tracking pixels and
 * remote stylesheets.
 */
export function isolateHtmlDocument(html: string): string {
  const policy =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\">";
  // Put the policy before all untrusted markup, even malformed documents
  // that place fetchable elements before <head>.
  return `<!doctype html>${policy}${html}`;
}

// ---------------------------------------------------------------------------
// Files this chat's tool calls created or changed
// ---------------------------------------------------------------------------

export type ChatFileChange = "created" | "changed";
export type ChatFile = { path: string; change: ChatFileChange; time: number | null };

export function collectChatFiles(
  messages: readonly TranscriptMessageEntry[],
  baseDirectory: string | null,
): ChatFile[] {
  const files = new Map<string, ChatFile>();
  const record = (rawPath: string, change: ChatFileChange, time: number | null) => {
    const path = resolveHostPath(rawPath, baseDirectory);
    if (!path) return;
    const key = comparable(path);
    const previous = files.get(key);
    files.set(key, {
      path,
      // A file created in this chat stays "created" when edited later.
      change: previous?.change === "created" ? "created" : change,
      time: time ?? previous?.time ?? null,
    });
  };

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue;
      const kind = normalizeKind(part.tool);
      const time = part.state.time?.end ?? part.state.time?.start ?? message.info.time.created;
      if (kind === "write") {
        const input = getToolInput(part.state);
        const path = stringField(input, "filePath") ?? stringField(input, "path");
        if (path) record(path, "created", time);
      } else if (kind === "edit") {
        for (const file of extractEditFiles(part.state)) {
          if (file.type === "delete") {
            const path = resolveHostPath(file.path, baseDirectory);
            if (path) files.delete(comparable(path));
            continue;
          }
          if (file.type === "move" && file.previousPath) {
            const previous = resolveHostPath(file.previousPath, baseDirectory);
            if (previous) files.delete(comparable(previous));
          }
          record(file.path, file.type === "add" ? "created" : "changed", time);
        }
      }
    }
  }

  return [...files.values()].sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
}
