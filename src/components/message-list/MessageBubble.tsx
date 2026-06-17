import { AlertTriangle, GitFork, Layers, Undo2 } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ImageMentionLightbox,
  ImageMentionThumbnails,
  type ImageMention,
} from "@/components/ImageMentionPreview";
import { ProviderIcon } from "@/components/provider-icons";
import { useConnectionState, useSessionState } from "@/hooks/use-agent-state";
import { USER_MSG_COLLAPSE_CHARS } from "@/lib/constants";
import { splitImageMentions } from "@/lib/image-mentions";
import { cn } from "@/lib/utils";
import type { TranscriptMessageEntry } from "@/protocol/session-transcript";
import { DurationLabel } from "./DurationLabel";
import { PartView } from "./PartView";
import type { TurnFooter } from "./types";

export const MessageBubble = memo(function MessageBubble({
  entry,
  turnFooter,
  onFork,
  onRevert,
  expandedUserMessages,
  expandedToolCalls,
  onToggleUserMessage,
  onToggleToolCall,
}: {
  entry: TranscriptMessageEntry;
  turnFooter?: TurnFooter;
  onFork?: () => void;
  onRevert?: () => void;
  expandedUserMessages?: ReadonlySet<string>;
  expandedToolCalls?: ReadonlySet<string>;
  onToggleUserMessage?: (messageId: string) => void;
  onToggleToolCall?: (partId: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const { attachmentBaseUrl } = useConnectionState();
  const { sessions, activeTargetDirectory } = useSessionState();
  const imageServerUrl = attachmentBaseUrl;
  const { info, parts } = entry;
  const imageBaseDirectory =
    sessions.find((session) => session.id === info.sessionID)?._projectDir ??
    sessions.find((session) => session.id === info.sessionID)?.directory ??
    activeTargetDirectory ??
    null;
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

  return (
    <div className={isUser ? "flex justify-end" : ""}>
      {isSummary && (
        <div className="flex items-center gap-2 mb-2 select-none">
          <div className="flex-1 h-px bg-amber-500/30" />
          <div className="flex items-center gap-1.5 text-[11px] text-amber-500/80 font-mono">
            <Layers className="size-3" />
            <span>{t("messageActions.contextCompacted")}</span>
          </div>
          <div className="flex-1 h-px bg-amber-500/30" />
        </div>
      )}
      <div
        className={cn(
          "min-w-0 group relative",
          isUser
            ? "bg-foreground/10 rounded-2xl px-4 py-2 max-w-[85%]"
            : "flex-1 flex flex-col gap-0",
        )}
      >
        {isUser && (onFork || onRevert) && (
          <div className="absolute -left-9 top-1/2 -translate-y-1/2 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {onRevert && (
              <button
                type="button"
                onClick={onRevert}
                title={t("messageActions.revertToMessage")}
                className="p-1 rounded hover:bg-foreground/10 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <Undo2 className="size-3.5" />
              </button>
            )}
            {onFork && (
              <button
                type="button"
                onClick={onFork}
                title={t("messageActions.forkFromMessage")}
                className="p-1 rounded hover:bg-foreground/10 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <GitFork className="size-3.5" />
              </button>
            )}
          </div>
        )}
        {userImages.length > 0 && (
          <ImageMentionThumbnails
            images={userImages}
            activePath={activeImagePath}
            onHover={setActiveImagePath}
            onOpen={setOpenImage}
            serverUrl={imageServerUrl}
            baseDirectory={imageBaseDirectory}
            className="mb-2"
          />
        )}
        {parts.length > 0 && (
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
                  isUser={isUser}
                  expandedToolCalls={expandedToolCalls}
                  onToggleToolCall={onToggleToolCall}
                  activeImagePath={activeImagePath}
                  onImageHover={setActiveImagePath}
                  onImageOpen={setOpenImage}
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
                onClick={() => onToggleUserMessage?.(info.id)}
                className="text-xs text-muted-foreground hover:text-foreground mt-1 cursor-pointer"
              >
                {expanded ? t("messageActions.showLess") : t("messageActions.showMore")}
              </button>
            )}
          </div>
        )}
        {info.role === "assistant" && info.error && (
          <div className="text-xs text-destructive flex items-center gap-1">
            <AlertTriangle className="size-3" />
            {"data" in info.error &&
            info.error.data &&
            typeof info.error.data === "object" &&
            "message" in info.error.data
              ? String(info.error.data.message)
              : info.error.name}
          </div>
        )}
        <ImageMentionLightbox
          image={openImage}
          serverUrl={imageServerUrl}
          baseDirectory={imageBaseDirectory}
          onClose={() => setOpenImage(null)}
        />
        {info.role === "assistant" && turnFooter && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
            <DurationLabel footer={turnFooter} />
            {turnFooter.providerID && (
              <ProviderIcon
                provider={turnFooter.providerID}
                className="size-3 shrink-0 opacity-60"
              />
            )}
            {turnFooter.modelID && <span className="opacity-60">{turnFooter.modelID}</span>}
            {turnFooter.thinkingLevel && (
              <span className="opacity-40">{turnFooter.thinkingLevel}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
