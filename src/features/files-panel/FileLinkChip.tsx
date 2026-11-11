import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { hostBasename, resolveHostPath, type FileLinkTarget } from "@/lib/host-files";
import { FileIcon } from "./FileIcon";
import { FileContextMenu } from "./FileContextMenu";
import { useFilesPanel } from "./files-panel-context";

/**
 * A file link from model output. Rendering it requests nothing; the file is
 * only read when the chip is clicked and the panel opens it.
 */
export function FileLinkChip({
  target,
  label,
  baseDirectory,
}: {
  target: FileLinkTarget;
  /** Link text; when it only repeats the path, the file name is shown instead. */
  label: ReactNode;
  baseDirectory: string | null;
}) {
  const { t } = useTranslation();
  const panel = useFilesPanel();
  const path = resolveHostPath(target.path, baseDirectory ?? panel?.root ?? null);
  const name = hostBasename(target.path);
  const lineSuffix = target.line ? `:${target.line}` : "";
  const content = (
    <>
      <FileIcon name={name} className="size-3.5" />
      <span className="min-w-0 truncate">{label}</span>
    </>
  );
  const className =
    "mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/50 px-1.5 py-px align-middle text-[0.92em] leading-snug";

  if (!panel || !path) {
    return (
      <span className={className} title={target.path}>
        {content}
      </span>
    );
  }
  const open = () => panel.openFile(path, target.line);
  return (
    <FileContextMenu path={path} onOpen={open}>
      <button
        type="button"
        className={`${className} cursor-pointer text-foreground hover:border-foreground/30 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none`}
        title={`${path}${lineSuffix}`}
        aria-label={t("filesPanel.openLink", { name: `${name}${lineSuffix}` })}
        onClick={open}
      >
        {content}
      </button>
    </FileContextMenu>
  );
}

/** Label for a chip whose link text is just the path itself. */
export function fileLinkLabel(text: string, href: string, target: FileLinkTarget): string | null {
  const trimmed = text.trim();
  if (trimmed && trimmed !== href.trim() && trimmed !== target.path) return null;
  return `${hostBasename(target.path)}${target.line ? `:${target.line}` : ""}`;
}
