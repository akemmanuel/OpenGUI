import { useTranslation } from "react-i18next";
import type { ImageMention } from "@/components/ImageMentionPreview";
import { cn } from "@/lib/utils";
import type { TranscriptPart } from "@/protocol/session-transcript";
import { PartView } from "./PartView";

export function CollapsibleUserMessageBody({
  parts,
  messageId,
  shouldCollapse,
  expanded,
  onToggleExpanded,
  expandedToolCalls,
  onSetToolCallExpanded,
  activeImagePath,
  onImageHover,
  onImageOpen,
  imageBaseDirectory,
}: {
  parts: TranscriptPart[];
  messageId: string;
  shouldCollapse: boolean;
  expanded: boolean;
  onToggleExpanded?: (messageId: string) => void;
  expandedToolCalls?: ReadonlySet<string>;
  onSetToolCallExpanded?: (partId: string, expanded: boolean) => void;
  activeImagePath?: string | null;
  onImageHover?: (path: string | null) => void;
  onImageOpen?: (image: ImageMention) => void;
  imageBaseDirectory?: string | null;
}) {
  const { t } = useTranslation();
  if (parts.length === 0) return null;

  return (
    <div className={cn(shouldCollapse && !expanded && "relative")}>
      <div
        className={cn(
          "flex flex-col gap-1",
          shouldCollapse && !expanded && "max-h-[8lh] overflow-hidden",
        )}
      >
        {parts.map((part) => (
          <PartView
            key={part.id}
            part={part}
            isUser
            expandedToolCalls={expandedToolCalls}
            onSetToolCallExpanded={onSetToolCallExpanded}
            activeImagePath={activeImagePath}
            onImageHover={onImageHover}
            onImageOpen={onImageOpen}
            imageBaseDirectory={imageBaseDirectory}
          />
        ))}
      </div>
      {shouldCollapse && !expanded && (
        <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t to-transparent rounded-b-2xl pointer-events-none" />
      )}
      {shouldCollapse && (
        <button
          type="button"
          onClick={() => onToggleExpanded?.(messageId)}
          className="text-xs text-muted-foreground hover:text-foreground mt-1 cursor-pointer"
        >
          {expanded ? t("messageActions.showLess") : t("messageActions.showMore")}
        </button>
      )}
    </div>
  );
}
