import type { ImageMention } from "@/components/ImageMentionPreview";
import type { TranscriptPart } from "@/protocol/session-transcript";
import type { ToolCallTranscriptPart } from "@/protocol/session-transcript";
import { PartView } from "./PartView";
import { ToolCallGroupView } from "./tools/ToolCallGroupView";

function groupConsecutiveTools(parts: TranscriptPart[]) {
  const groups: (TranscriptPart | ToolCallTranscriptPart[])[] = [];
  for (const part of parts) {
    const last = groups.at(-1);
    if (part.type === "tool" && Array.isArray(last)) last.push(part);
    else groups.push(part.type === "tool" ? [part] : part);
  }
  return groups;
}

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
      {groupConsecutiveTools(parts).map((partOrGroup) =>
        Array.isArray(partOrGroup) ? (
          partOrGroup.length === 1 ? (
            <PartView
              key={partOrGroup[0]!.id}
              part={partOrGroup[0]!}
              expandedToolCalls={expandedToolCalls}
              onSetToolCallExpanded={onSetToolCallExpanded}
              activeImagePath={activeImagePath}
              onImageHover={onImageHover}
              onImageOpen={onImageOpen}
              imageBaseDirectory={imageBaseDirectory}
            />
          ) : (
            <ToolCallGroupView
              key={`tool-group:${partOrGroup[0]?.id}`}
              parts={partOrGroup}
              expandedToolCalls={expandedToolCalls}
              onSetToolCallExpanded={onSetToolCallExpanded}
            />
          )
        ) : (
          <PartView
            key={partOrGroup.id}
            part={partOrGroup}
            isUser={isUser}
            expandedToolCalls={expandedToolCalls}
            onSetToolCallExpanded={onSetToolCallExpanded}
            activeImagePath={activeImagePath}
            onImageHover={onImageHover}
            onImageOpen={onImageOpen}
            imageBaseDirectory={imageBaseDirectory}
          />
        ),
      )}
    </div>
  );
}
