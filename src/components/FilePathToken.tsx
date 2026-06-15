import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getShellKind } from "@/runtime/shell-policy";
import { cleanFilePathToken } from "@/lib/file-paths";
import { cn, copyTextToClipboard, getErrorMessage } from "@/lib/utils";

export function FilePathToken({
  path,
  baseDirectory,
  className,
}: {
  path: string;
  baseDirectory?: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const filePath = cleanFilePathToken(path);
  const shellKind = getShellKind();
  const canUseShell = !!window.electronAPI?.openFile;
  const [exists, setExists] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setExists(false);

    if (!baseDirectory || shellKind === "mobile" || !window.electronAPI?.fileExists) return;

    window.electronAPI
      .fileExists(filePath, baseDirectory)
      .then((result) => {
        if (!cancelled) setExists(result);
      })
      .catch(() => {
        if (!cancelled) setExists(false);
      });

    return () => {
      cancelled = true;
    };
  }, [baseDirectory, filePath, shellKind]);

  const copyPathFallback = async (messageKey: string) => {
    await copyTextToClipboard(filePath);
    toast.info(t(messageKey));
  };

  const handleOpen = async () => {
    if (shellKind === "mobile") {
      await copyPathFallback("fileActions.mobileUnavailable");
      return;
    }

    if (!canUseShell) {
      await copyPathFallback("fileActions.openUnavailable");
      return;
    }

    try {
      const opened = await window.electronAPI?.openFile?.(filePath, baseDirectory ?? undefined);
      if (!opened) {
        await copyPathFallback("fileActions.openFailedCopied");
      }
    } catch (error) {
      await copyTextToClipboard(filePath);
      toast.error(getErrorMessage(error, t("fileActions.openFailedCopied")));
    }
  };

  if (!exists) {
    return (
      <code className="rounded bg-muted px-[0.3rem] py-[0.1rem] font-mono text-[0.85em] font-medium">
        {path}
      </code>
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "inline-flex max-w-full cursor-pointer items-center gap-1 rounded bg-muted px-[0.3rem] py-[0.1rem] align-baseline font-mono text-[0.85em] font-medium text-foreground transition-colors hover:bg-muted/80 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      onClick={handleOpen}
      title={t("fileActions.openFile")}
      aria-label={t("fileActions.openFile")}
    >
      <span className="truncate">{path}</span>
      {shellKind !== "mobile" && <ExternalLink className="size-3 shrink-0 opacity-60" />}
    </button>
  );
}
