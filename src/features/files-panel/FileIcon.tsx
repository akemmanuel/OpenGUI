import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  type LucideIcon,
} from "lucide-react";
import { fileExtension } from "@/lib/host-files";
import { cn } from "@/lib/utils";

const CODE = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "htm",
  "java",
  "js",
  "jsx",
  "json",
  "kt",
  "less",
  "lua",
  "mjs",
  "cjs",
  "php",
  "pl",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "bash",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
  "astro",
]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico", "heic"]);
const SHEET = new Set(["csv", "tsv", "xls", "xlsx", "ods", "numbers"]);
const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"]);
const DOCUMENT = new Set([
  "pdf",
  "md",
  "markdown",
  "mdx",
  "txt",
  "rtf",
  "doc",
  "docx",
  "odt",
  "log",
]);

function iconFor(name: string): { Icon: LucideIcon; tone: string } {
  const extension = fileExtension(name);
  if (extension === "pdf") return { Icon: FileText, tone: "text-red-500" };
  if (IMAGE.has(extension)) return { Icon: FileImage, tone: "text-sky-500" };
  if (SHEET.has(extension)) return { Icon: FileSpreadsheet, tone: "text-emerald-500" };
  if (ARCHIVE.has(extension)) return { Icon: FileArchive, tone: "text-amber-500" };
  if (CODE.has(extension)) return { Icon: FileCode, tone: "text-violet-500" };
  if (DOCUMENT.has(extension)) return { Icon: FileText, tone: "text-muted-foreground" };
  return { Icon: File, tone: "text-muted-foreground" };
}

export function FileIcon({
  name,
  folder = false,
  className,
}: {
  name: string;
  folder?: boolean;
  className?: string;
}) {
  if (folder) {
    return (
      <Folder
        aria-hidden
        className={cn("size-4 shrink-0 fill-muted-foreground/20 text-muted-foreground", className)}
      />
    );
  }
  const { Icon, tone } = iconFor(name);
  return <Icon aria-hidden className={cn("size-4 shrink-0", tone, className)} />;
}
