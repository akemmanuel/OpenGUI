import type { Part } from "@opencode-ai/sdk/v2/client";
import { memo } from "react";
import type { ImageMention } from "@/components/ImageMentionPreview";
import { ToolPartView } from "@/components/message-list/tools/ToolPartView";
import { FilePartView } from "./FilePartView";
import { ReasoningPartView } from "./ReasoningPartView";
import { TextPartView } from "./TextPartView";

export const PartView = memo(function PartView({
  part,
  isUser,
  lastReasoningPartId,
  expandedToolParts,
  onToggleToolPart,
  activeImagePath,
  onImageHover,
  onImageOpen,
  imageBaseDirectory,
  imageServerUrl,
  imageAuthToken,
}: {
  part: Part;
  isUser?: boolean;
  lastReasoningPartId?: string;
  expandedToolParts?: ReadonlySet<string>;
  onToggleToolPart?: (partId: string, expanded: boolean) => void;
  activeImagePath?: string | null;
  onImageHover?: (path: string | null) => void;
  onImageOpen?: (image: ImageMention) => void;
  imageBaseDirectory?: string | null;
  imageServerUrl?: string | null;
  imageAuthToken?: string | null;
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
          imageServerUrl={imageServerUrl}
          imageAuthToken={imageAuthToken}
        />
      );
    case "file":
      return (
        <FilePartView part={part} imageServerUrl={imageServerUrl} imageAuthToken={imageAuthToken} />
      );
    case "reasoning":
      return <ReasoningPartView part={part} isLastReasoning={part.id === lastReasoningPartId} />;
    case "tool":
      return (
        <ToolPartView
          part={part}
          expandedToolParts={expandedToolParts}
          onToggleToolPart={onToggleToolPart}
          imageServerUrl={imageServerUrl}
          imageAuthToken={imageAuthToken}
        />
      );
    case "step-start":
    case "step-finish":
    case "snapshot":
    case "patch":
    case "compaction":
    case "retry":
      return null;
    default:
      return null;
  }
});
