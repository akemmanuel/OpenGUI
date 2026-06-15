import { memo } from "react";
import type { ImageMention } from "@/components/ImageMentionPreview";
import { ToolCallPartView } from "@/components/message-list/tools/ToolCallPartView";
import type { TranscriptPart } from "@/protocol/session-transcript";
import { FilePartView } from "./FilePartView";
import { ReasoningPartView } from "./ReasoningPartView";
import { TextPartView } from "./TextPartView";

export const PartView = memo(function PartView({
  part,
  isUser,
  lastReasoningPartId,
  expandedToolCalls,
  onToggleToolCall,
  activeImagePath,
  onImageHover,
  onImageOpen,
  imageBaseDirectory,
}: {
  part: TranscriptPart;
  isUser?: boolean;
  lastReasoningPartId?: string;
  expandedToolCalls?: ReadonlySet<string>;
  onToggleToolCall?: (partId: string, expanded: boolean) => void;
  activeImagePath?: string | null;
  onImageHover?: (path: string | null) => void;
  onImageOpen?: (image: ImageMention) => void;
  imageBaseDirectory?: string | null;
}) {
  switch (part.type) {
    case "text":
      return (
        <TextPartView
          part={part}
          isUser={isUser}
          activeImagePath={activeImagePath}
          onImageHover={onImageHover}
          onImageOpen={onImageOpen}
          imageBaseDirectory={imageBaseDirectory}
        />
      );
    case "file":
      return <FilePartView part={part} />;
    case "reasoning":
      return <ReasoningPartView part={part} isLastReasoning={part.id === lastReasoningPartId} />;
    case "tool":
      return (
        <ToolCallPartView
          part={part}
          expandedToolCalls={expandedToolCalls}
          onToggleToolCall={onToggleToolCall}
        />
      );
    case "step-start":
    case "step-finish":
    case "snapshot":
    case "patch":
    case "compaction":
    case "retry":
    case "subtask":
    case "agent":
      return null;
    default:
      return null;
  }
});
