import { CheckCircle2, Circle, Wrench, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { TerminalOutput } from "@/components/message-list/TerminalOutput";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { todoStatusConfig } from "@/lib/todos";
import { cn, copyTextToClipboard, looksLikeTerminalOutput } from "@/lib/utils";
import { ApplyPatchFilesView } from "./ApplyPatchFilesView";
import type { ToolOutputBlock } from "./toolCallModel";

function ToolImages({ block }: { block: Extract<ToolOutputBlock, { type: "images" }> }) {
  return (
    <div className={cn("grid gap-2", block.images.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
      {block.images.map((image, idx) => (
        <div
          key={`${image.url}-${idx}`}
          className="overflow-hidden rounded-md border border-border/60 bg-background/60"
        >
          <img
            src={image.src}
            alt={image.filename ?? `Image attachment ${idx + 1}`}
            loading="lazy"
            className="w-full max-h-52 object-contain bg-black/20"
          />
        </div>
      ))}
    </div>
  );
}

export function ToolCallOutputView({
  blocks,
  rawOutput,
}: {
  blocks: ToolOutputBlock[];
  rawOutput?: string | null;
}) {
  const { t } = useTranslation();
  const [rawOpen, setRawOpen] = useState(false);

  return (
    <div className="pl-5 pt-1 space-y-1">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "text":
            return block.format === "terminal" ? (
              <TerminalOutput key={index} content={block.text} className="max-h-64" />
            ) : (
              <pre
                key={index}
                className="whitespace-pre-wrap break-words text-xs text-muted-foreground"
              >
                {block.text}
              </pre>
            );
          case "diff":
            return <ApplyPatchFilesView key={index} files={block.files} />;
          case "images":
            return <ToolImages key={index} block={block} />;
          case "todos":
            return (
              <div key={index} className="space-y-0.5">
                {block.todos.map((todo, i) => {
                  const cfg = todoStatusConfig[todo.status] ?? {
                    icon: Circle,
                    color: "text-muted-foreground",
                  };
                  const Icon = cfg.icon;
                  return (
                    <div key={`${todo.content}-${i}`} className="flex items-center gap-1.5 min-h-5">
                      <Icon className={cn("size-3 shrink-0", cfg.color)} />
                      <span
                        className={cn(
                          "flex-1 text-[11px] leading-tight",
                          todo.status === "cancelled" && "line-through opacity-50",
                          todo.status === "completed" && "text-muted-foreground",
                        )}
                      >
                        {todo.content}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          case "task":
            return (
              <div key={index} className="space-y-1">
                {block.taskInfo.toolCalls.length > 0 && (
                  <div className="space-y-0.5">
                    {block.taskInfo.toolCalls.map((tc, i) => (
                      <div
                        key={`${tc.tool}-${i}`}
                        className="flex items-center gap-1.5 text-xs font-mono"
                      >
                        <Wrench className="size-2.5 text-muted-foreground shrink-0" />
                        <span className="text-muted-foreground">{tc.tool}</span>
                        {tc.title && (
                          <span className="text-muted-foreground/70 truncate">{tc.title}</span>
                        )}
                        {tc.status === "completed" && (
                          <CheckCircle2 className="size-2.5 text-emerald-500 ml-auto shrink-0" />
                        )}
                        {tc.status === "error" && (
                          <XCircle className="size-2.5 text-destructive ml-auto shrink-0" />
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {block.taskInfo.output &&
                  (looksLikeTerminalOutput(block.taskInfo.output) ? (
                    <TerminalOutput content={block.taskInfo.output} className="max-h-64" />
                  ) : (
                    <div className="text-xs">
                      <MarkdownRenderer content={block.taskInfo.output} />
                    </div>
                  ))}
              </div>
            );
        }
      })}
      {rawOutput && (
        <div className="pt-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-5 px-1.5 text-[11px] text-muted-foreground"
            onClick={() => setRawOpen(true)}
          >
            {t("toolOutput.showRaw")}
          </Button>
          <Dialog open={rawOpen} onOpenChange={setRawOpen}>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>{t("toolOutput.rawTitle")}</DialogTitle>
                <DialogDescription>{t("toolOutput.rawDescription")}</DialogDescription>
              </DialogHeader>
              <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border/60 bg-background/70 p-3 text-xs text-muted-foreground whitespace-pre-wrap break-words">
                {rawOutput}
              </pre>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void copyTextToClipboard(rawOutput)}
                >
                  {t("toolOutput.copyRaw")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </div>
  );
}
