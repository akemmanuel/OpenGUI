import { memo, useMemo, useState } from "react";
import {
  ImageMentionLightbox,
  ImageMentionThumbnails,
  type ImageMention,
} from "@/components/ImageMentionPreview";

import { USER_MSG_COLLAPSE_CHARS } from "@/lib/constants";
import { splitImageMentions } from "@/lib/image-mentions";
import { cn } from "@/lib/utils";
import type { TranscriptMessageEntry } from "@/protocol/session-transcript";
import { ActorAttribution } from "@/features/identity/ActorAttribution";
import { AssistantMessageError } from "./AssistantMessageError";
import { AssistantTurnFooter } from "./AssistantTurnFooter";
import { CollapsibleUserMessageBody } from "./CollapsibleUserMessageBody";
import { ContextCompactedBanner } from "./ContextCompactedBanner";
import { MessageBubbleActions } from "./MessageBubbleActions";
import { MessagePartsStack } from "./MessagePartsStack";
import type { TurnFooter } from "./types";

export const MessageBubble = memo(function MessageBubble({
  entry,
  turnFooter,
  onFork,
  onRevert,
  expandedUserMessages,
  expandedToolCalls,
  onToggleUserMessage,
  onSetToolCallExpanded,
  imageBaseDirectory,
  attachmentBaseUrl,
}: {
  entry: TranscriptMessageEntry;
  turnFooter?: TurnFooter;
  onFork?: () => void;
  onRevert?: () => void;
  expandedUserMessages?: ReadonlySet<string>;
  expandedToolCalls?: ReadonlySet<string>;
  onToggleUserMessage?: (messageId: string) => void;
  onSetToolCallExpanded?: (partId: string, expanded: boolean) => void;
  imageBaseDirectory: string | null;
  attachmentBaseUrl: string | null;
}) {
  const { info, parts } = entry;
  const isUser = info.role === "user";
  const expanded = expandedUserMessages?.has(info.id) ?? false;
  const isSummary = info.role === "assistant" && "summary" in info && info.summary === true;
  const [activeImagePath, setActiveImagePath] = useState<string | null>(null);
  const [openImage, setOpenImage] = useState<ImageMention | null>(null);

  const userImages = useMemo(() => {
    if (!isUser) return [];
    const seen = new Set<string>();
    const images: ImageMention[] = [];
    for (const part of parts) {
      if (part.type !== "text" || !part.text) continue;
      for (const segment of splitImageMentions(part.text)) {
        if (segment.type !== "image" || seen.has(segment.path)) continue;
        seen.add(segment.path);
        images.push({ path: segment.path, filename: segment.filename });
      }
    }
    return images;
  }, [isUser, parts]);

  const userTextLength = isUser
    ? parts.reduce((sum, p) => sum + (p.type === "text" ? (p.text?.length ?? 0) : 0), 0)
    : 0;
  const shouldCollapse = isUser && userTextLength > USER_MSG_COLLAPSE_CHARS;

  const partProps = {
    expandedToolCalls,
    onSetToolCallExpanded,
    activeImagePath,
    onImageHover: setActiveImagePath,
    onImageOpen: setOpenImage,
    imageBaseDirectory,
  };

  return (
    <div className={isUser ? "flex justify-end" : ""}>
      {isSummary && <ContextCompactedBanner />}
      <div
        className={cn(
          "min-w-0 group relative",
          isUser
            ? "bg-foreground/10 rounded-2xl px-4 py-2 max-w-[85%]"
            : "flex-1 flex flex-col gap-0",
        )}
      >
        {isUser && <MessageBubbleActions onFork={onFork} onRevert={onRevert} />}
        {isUser && <ActorAttribution actor={info.actor} className="mb-1 block" />}
        {userImages.length > 0 && (
          <ImageMentionThumbnails
            images={userImages}
            activePath={activeImagePath}
            onHover={setActiveImagePath}
            onOpen={setOpenImage}
            serverUrl={attachmentBaseUrl}
            baseDirectory={imageBaseDirectory}
            className="mb-2"
          />
        )}
        {isUser ? (
          <CollapsibleUserMessageBody
            parts={parts}
            messageId={info.id}
            shouldCollapse={shouldCollapse}
            expanded={expanded}
            onToggleExpanded={onToggleUserMessage}
            {...partProps}
          />
        ) : (
          <MessagePartsStack
            parts={parts}
            isAssistantTurnActive={!info.time.completed && !info.error}
            {...partProps}
          />
        )}
        {info.role === "assistant" && info.error && <AssistantMessageError error={info.error} />}
        <ImageMentionLightbox
          image={openImage}
          serverUrl={attachmentBaseUrl}
          baseDirectory={imageBaseDirectory}
          onClose={() => setOpenImage(null)}
        />
        {info.role === "assistant" && turnFooter && <AssistantTurnFooter footer={turnFooter} />}
      </div>
    </div>
  );
});
