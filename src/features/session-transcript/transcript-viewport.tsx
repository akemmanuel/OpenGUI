import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import {
  ScrollTimeIndicator,
  useScrollTimeIndicator,
} from "@/features/session-transcript/scroll-time-indicator";
import {
  TranscriptNavigation,
  useTranscriptNavigation,
} from "@/features/session-transcript/transcript-navigation";
import type { PromptMarker } from "@/features/session-transcript/transcript-prompt-markers";
import { TranscriptPromptRail } from "@/features/session-transcript/transcript-prompt-rail";
import { usePinnedScroll } from "@/features/session-transcript/use-pinned-scroll";

export function TranscriptViewport({
  sessionId,
  contentKey,
  pinWhenNearBottom,
  isLoadingOlder,
  loadOlderError,
  onLoadOlder,
  showLoadOlderRow,
  children,
  trailingContent,
  promptMarkers = [],
}: {
  sessionId: string | null;
  contentKey: string;
  pinWhenNearBottom: boolean;
  isLoadingOlder: boolean;
  loadOlderError?: string | null;
  onLoadOlder: () => Promise<boolean>;
  showLoadOlderRow: boolean;
  children: ReactNode;
  trailingContent?: ReactNode;
  promptMarkers?: readonly PromptMarker[];
}) {
  const { t } = useTranslation();
  const { scrollRef, onScroll, detachPin, capturePrependAnchor, scrollToBottom } = usePinnedScroll({
    sessionId,
    contentKey,
    pinWhenNearBottom,
  });
  const timeIndicator = useScrollTimeIndicator(scrollRef);
  const navigation = useTranscriptNavigation({
    scrollRef,
    sessionId,
    contentKey,
    scrollToBottom,
    detachPin,
  });

  const handleLoadOlder = () => {
    detachPin();
    capturePrependAnchor();
    void onLoadOlder();
  };

  const showPromptRail = promptMarkers.length > 1;

  return (
    <div key={sessionId} className="relative flex min-h-0 flex-1 flex-col pt-6">
      <ScrollTimeIndicator label={timeIndicator.label} visible={timeIndicator.visible} />
      <div
        ref={scrollRef}
        onScroll={() => {
          onScroll();
          timeIndicator.onScroll();
          navigation.onScroll();
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) detachPin();
        }}
        className={`relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-background pr-3 pb-6 min-[375px]:pr-4 md:px-8 [overflow-anchor:none] ${showPromptRail ? "pl-8" : "pl-3 min-[375px]:pl-4"}`}
      >
        <div className="chat-column flex min-w-0 flex-col">
          {showLoadOlderRow && (
            <div className="flex flex-col items-center justify-center gap-1 py-2">
              {isLoadingOlder ? (
                <Spinner className="size-4 text-muted-foreground" />
              ) : (
                <Button type="button" variant="ghost" size="sm" onClick={handleLoadOlder}>
                  {t("messageList.loadOlder")}
                </Button>
              )}
              {loadOlderError && !isLoadingOlder && (
                <div className="max-w-md text-center text-xs text-destructive">
                  {t("messageList.loadOlderFailed")}
                </div>
              )}
            </div>
          )}
          {children}
          {trailingContent}
          <TranscriptNavigation
            awayFromBottom={navigation.awayFromBottom}
            hasUnseen={navigation.hasUnseen}
            onJumpToEnd={navigation.jumpToEnd}
          />
        </div>
      </div>
      {showPromptRail && (
        <TranscriptPromptRail
          markers={promptMarkers}
          activeId={navigation.activePromptId ?? promptMarkers.at(-1)?.id ?? null}
          onSelect={navigation.jumpToMessage}
        />
      )}
    </div>
  );
}
