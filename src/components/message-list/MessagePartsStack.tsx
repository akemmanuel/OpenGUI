import type { ImageMention } from "@/components/ImageMentionPreview";
import type { TranscriptPart } from "@/protocol/session-transcript";
import { PartView } from "./PartView";

export function MessagePartsStack({
  parts,
  isUser,
  expandedToolCalls,
  onSetToolCallExpanded,
  activeImagePath,
  onImageHover,
  onImageOpen,
  imageBaseDirectory,
}: {
  parts: TranscriptPart[];
  isUser?: boolean;
  expandedToolCalls?: ReadonlySet<string>;
  onSetToolCallExpanded?: (partId: string, expanded: boolean) => void;
  activeImagePath?: string | null;
  onImageHover?: (path: string | null) => void;
  onImageOpen?: (image: ImageMention) => void;
  imageBaseDirectory?: string | null;
}) {
  if (parts.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {parts.map((part) => (
        <PartView
          key={part.id}
          part={part}
          isUser={isUser}
          expandedToolCalls={expandedToolCalls}
          onSetToolCallExpanded={onSetToolCallExpanded}
          activeImagePath={activeImagePath}
          onImageHover={onImageHover}
          onImageOpen={onImageOpen}
          imageBaseDirectory={imageBaseDirectory}
        />
      ))}
    </div>
  );
}
