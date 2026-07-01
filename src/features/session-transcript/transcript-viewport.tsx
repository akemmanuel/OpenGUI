import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
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
}) {
  const { t } = useTranslation();
  const { scrollRef, onScroll, detachPin, capturePrependAnchor } = usePinnedScroll({
    sessionId,
    contentKey,
    pinWhenNearBottom,
  });

  const handleLoadOlder = () => {
    detachPin();
    capturePrependAnchor();
    void onLoadOlder();
  };

  return (
    <div
      key={sessionId}
      ref={scrollRef}
      onScroll={onScroll}
      onWheel={(event) => {
        if (event.deltaY < 0) detachPin();
      }}
      className="relative flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 [overflow-anchor:none]"
    >
      <div className="max-w-2xl mx-auto flex flex-col gap-0">
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
      </div>
    </div>
  );
}
