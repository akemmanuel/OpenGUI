import { useMemo } from "react";
import { cn, normalizeTerminalOutput } from "@/lib/utils";

export function TerminalOutput({
  content,
  className,
  preRef,
}: {
  content: string;
  className?: string;
  preRef?: React.RefObject<HTMLPreElement | null>;
}) {
  const normalizedContent = useMemo(() => normalizeTerminalOutput(content), [content]);

  return (
    <pre
      ref={preRef}
      className={cn(
        "terminal-output select-text w-full min-w-0 max-w-full text-muted-foreground overflow-y-auto overflow-x-hidden",
        className,
      )}
    >
      {normalizedContent}
    </pre>
  );
}
