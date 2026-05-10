import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { MessageEntry } from "@/hooks/use-agent-state";
import { NEAR_BOTTOM_PX } from "@/lib/constants";

const OVERSCAN_IDLE = 10;
const OVERSCAN_BUSY = 14;
const LOAD_OLDER_THRESHOLD_INDEX = 4;

function estimateMessageSize(message: MessageEntry): number {
  if (message.info.role === "user") return 92;
  const partCount = message.parts.length;
  const textLength = message.parts.reduce((sum, part) => {
    if (part.type !== "text") return sum;
    return sum + (part.text?.length ?? 0);
  }, 0);
  return Math.min(720, Math.max(140, 120 + partCount * 36 + Math.ceil(textLength / 90) * 18));
}

function isNearBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
}

export function VirtualMessageScroller({
  messages,
  isBusy,
  hasOlder,
  isLoadingOlder,
  loadOlder,
  renderMessage,
  trailingContent,
}: {
  messages: MessageEntry[];
  isBusy: boolean;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => Promise<boolean>;
  renderMessage: (entry: MessageEntry, index: number) => ReactNode;
  trailingContent?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sizeCacheRef = useRef(new Map<string, number>());
  const anchorRef = useRef<{ key: string; offsetFromViewportTop: number } | null>(null);
  const lastMessageKeyRef = useRef<string | null>(null);
  const loadInFlightRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const pinnedToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const keys = useMemo(() => messages.map((message) => message.info.id), [messages]);
  const keyIndex = useMemo(() => {
    const map = new Map<string, number>();
    keys.forEach((key, index) => map.set(key, index));
    return map;
  }, [keys]);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => keys[index] ?? index,
    estimateSize: (index) => {
      const message = messages[index];
      if (!message) return 160;
      return sizeCacheRef.current.get(message.info.id) ?? estimateMessageSize(message);
    },
    overscan: isBusy ? OVERSCAN_BUSY : OVERSCAN_IDLE,
    useAnimationFrameWithResizeObserver: true,
  });

  const captureAnchor = useCallback(() => {
    const scrollEl = scrollRef.current;
    const first = virtualizer.getVirtualItems()[0];
    if (!scrollEl || !first) return;
    const key = String(first.key);
    anchorRef.current = {
      key,
      offsetFromViewportTop: first.start - scrollEl.scrollTop,
    };
  }, [virtualizer]);

  const restoreAnchor = useCallback(() => {
    const scrollEl = scrollRef.current;
    const anchor = anchorRef.current;
    if (!scrollEl || !anchor) return false;
    const index = keyIndex.get(anchor.key);
    if (index == null) return false;
    virtualizer.scrollToIndex(index, { align: "start" });
    requestAnimationFrame(() => {
      const row = virtualizer.getVirtualItems().find((item) => String(item.key) === anchor.key);
      const nextStart = row?.start;
      if (typeof nextStart === "number") {
        programmaticScrollRef.current = true;
        scrollEl.scrollTop = Math.max(0, nextStart - anchor.offsetFromViewportTop);
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
        });
      }
    });
    anchorRef.current = null;
    return true;
  }, [keyIndex, virtualizer]);

  const scrollToLatest = useCallback(() => {
    if (messages.length === 0) return;
    pinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
    programmaticScrollRef.current = true;
    virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    });
  }, [messages.length, virtualizer]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || programmaticScrollRef.current) return;
    const nearBottom = isNearBottom(el);
    pinnedToBottomRef.current = nearBottom;
    if (nearBottom) setShowJumpToLatest(false);
  }, []);

  useLayoutEffect(() => {
    restoreAnchor();
  }, [restoreAnchor, messages.length]);

  useEffect(() => {
    const lastKey = keys.at(-1) ?? null;
    const previousLastKey = lastMessageKeyRef.current;
    lastMessageKeyRef.current = lastKey;
    if (!lastKey) return;
    if (previousLastKey === null || pinnedToBottomRef.current) {
      scrollToLatest();
      return;
    }
    if (previousLastKey !== lastKey) setShowJumpToLatest(true);
  }, [keys, scrollToLatest]);

  useEffect(() => {
    const firstIndex = virtualizer.getVirtualItems()[0]?.index;
    if (
      firstIndex == null ||
      firstIndex > LOAD_OLDER_THRESHOLD_INDEX ||
      !hasOlder ||
      isLoadingOlder ||
      loadInFlightRef.current
    ) {
      return;
    }

    loadInFlightRef.current = true;
    captureAnchor();
    void loadOlder().finally(() => {
      loadInFlightRef.current = false;
    });
  }, [captureAnchor, hasOlder, isLoadingOlder, loadOlder, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="relative flex-1 overflow-auto px-4 py-4"
    >
      <div className="max-w-[640px] mx-auto">
        {isLoadingOlder && (
          <div className="flex items-center justify-center py-3">
            <Spinner className="size-4 text-muted-foreground" />
          </div>
        )}
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualItem) => {
            const message = messages[virtualItem.index];
            if (!message) return null;
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={(node) => {
                  if (!node) return;
                  virtualizer.measureElement(node);
                  sizeCacheRef.current.set(message.info.id, node.getBoundingClientRect().height);
                }}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {renderMessage(message, virtualItem.index)}
              </div>
            );
          })}
        </div>
        {trailingContent}
      </div>
      {showJumpToLatest && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={scrollToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-lg"
        >
          <ArrowDown className="size-3.5" />
          Latest
        </Button>
      )}
    </div>
  );
}
