import { ExternalLink } from "lucide-react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn, openExternalLink } from "@/lib/utils";

export function LinkToken({ url, className }: { url: string; className?: string }) {
  const { t } = useTranslation();

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openExternalLink(url);
  };

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded bg-muted px-[0.3rem] py-[0.1rem] align-baseline font-mono text-[0.85em] font-medium text-foreground transition-colors hover:bg-muted/80 hover:text-primary hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      onClick={handleClick}
      title={t("fileActions.openLink")}
      aria-label={t("fileActions.openLink")}
    >
      <span className="truncate">{url}</span>
      <ExternalLink className="size-3 shrink-0 opacity-60" />
    </a>
  );
}
