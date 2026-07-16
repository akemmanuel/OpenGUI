import type { ImageMention } from "@/components/ImageMentionPreview";
import type { TranscriptPart } from "@/protocol/session-transcript";
import { PartView } from "./PartView";
import { ToolCallGroupView } from "./tools/ToolCallGroupView";

/**
 * Group tool activity until the model emits user-facing text. Reasoning is
 * transparent here: it remains renderable, but it must not fragment one tool
 * summary into several "Read/Ran/Edited" rows.
 */
export function groupToolsUntilAssistantText(parts: TranscriptPart[]) {
  const groups: (TranscriptPart | TranscriptPart[])[] = [];
  let activity: TranscriptPart[] = [];

  const flushActivity = () => {
    if (activity.length === 0) return;
    if (activity.some((part) => part.type === "tool")) groups.push(activity);
    else groups.push(...activity);
    activity = [];
  };

  for (const part of parts) {
    if (part.type === "text") {
      flushActivity();
      groups.push(part);
    } else {
      activity.push(part);
    }
  }
  flushActivity();
  return groups;
}

export function MessagePartsStack({
  parts,
  isUser,
  isAssistantTurnActive,
  expandedToolCalls,
  onSetToolCallExpanded,
  activeImagePath,
  onImageHover,
  onImageOpen,
  imageBaseDirectory,
}: {
  parts: TranscriptPart[];
  isUser?: boolean;
  isAssistantTurnActive?: boolean;
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
      {groupToolsUntilAssistantText(parts).map((partOrGroup, index, groups) =>
        Array.isArray(partOrGroup) ? (
          partOrGroup.length === 1 && partOrGroup[0]?.type === "tool" ? (
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
              awaitingAssistantResponse={isAssistantTurnActive && index === groups.length - 1}
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
