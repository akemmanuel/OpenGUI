import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type MutableRefObject,
  type ReactNode,
  type WheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { Spinner } from "@/components/ui/spinner";
import type { MessageEntry } from "@/hooks/use-agent-state";
import { NEAR_BOTTOM_PX } from "@/lib/constants";

const OVERSCAN_IDLE = 10;
const OVERSCAN_BUSY = 14;
const LOAD_OLDER_THRESHOLD_INDEX = 4;
const RESTORE_RETRY_FRAMES = 3;

export type ScrollSnapshot = {
  anchorKey: string | null;
  offsetFromViewportTop: number;
  scrollTop: number;
  distanceFromBottom: number;
  atTop: boolean;
  pinnedToBottom: boolean;
  updatedAt: number;
};

function estimateMessageSize(message: MessageEntry): number {
  if (message.info.role === "user") return 92;
  const partCount = message.parts.length;
  const textLength = message.parts.reduce((sum, part) => {
    if (part.type !== "text") return sum;
    return sum + (part.text?.length ?? 0);
  }, 0);
  return Math.min(720, Math.max(140, 120 + partCount * 36 + Math.ceil(textLength / 90) * 18));
}

export function distanceFromBottom(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
) {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

export function isAtTop(element: Pick<HTMLElement, "scrollTop">) {
  return element.scrollTop <= NEAR_BOTTOM_PX;
}

export function isNearBottom(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
) {
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (maxScrollTop <= NEAR_BOTTOM_PX) return true;
  if (isAtTop(element)) return false;
  return distanceFromBottom(element) <= NEAR_BOTTOM_PX;
}

export function VirtualMessageScroller({
  scrollKey,
  scrollSnapshotsRef,
  messages,
  isBusy,
  hasOlder,
  isLoadingOlder,
  loadOlder,
  renderMessage,
  trailingContent,
}: {
  scrollKey: string | null;
  scrollSnapshotsRef: MutableRefObject<Map<string, ScrollSnapshot>>;
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
  const paginationAnchorRef = useRef<{ key: string; offsetFromViewportTop: number } | null>(null);
  const lastMessageKeyRef = useRef<string | null>(null);
  const loadInFlightRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const pinnedToBottomRef = useRef(true);
  const restoredScrollKeyRef = useRef<string | null>(null);
  const snapshotFrameRef = useRef<number | null>(null);

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

  const writeScrollSnapshot = useCallback(
    (sessionId: string) => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;
      const first = virtualizer.getVirtualItems()[0];
      const atTop = isAtTop(scrollEl);
      const pinnedToBottom = isNearBottom(scrollEl);
      pinnedToBottomRef.current = pinnedToBottom;
      scrollSnapshotsRef.current.set(sessionId, {
        anchorKey: first ? String(first.key) : null,
        offsetFromViewportTop: first ? first.start - scrollEl.scrollTop : 0,
        scrollTop: scrollEl.scrollTop,
        distanceFromBottom: distanceFromBottom(scrollEl),
        atTop,
        pinnedToBottom,
        updatedAt: Date.now(),
      });
    },
    [scrollSnapshotsRef, virtualizer],
  );

  const captureScrollSnapshot = useCallback(() => {
    if (!scrollKey) return;
    writeScrollSnapshot(scrollKey);
  }, [scrollKey, writeScrollSnapshot]);

  const scheduleScrollSnapshot = useCallback(() => {
    if (snapshotFrameRef.current != null) return;
    snapshotFrameRef.current = requestAnimationFrame(() => {
      snapshotFrameRef.current = null;
      captureScrollSnapshot();
    });
  }, [captureScrollSnapshot]);

  const capturePaginationAnchor = useCallback(() => {
    const scrollEl = scrollRef.current;
    const first = virtualizer.getVirtualItems()[0];
    if (!scrollEl || !first) return;
    paginationAnchorRef.current = {
      key: String(first.key),
      offsetFromViewportTop: first.start - scrollEl.scrollTop,
    };
  }, [virtualizer]);

  const setProgrammaticScrollTop = useCallback((scrollTop: number) => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    programmaticScrollRef.current = true;
    scrollEl.scrollTop = Math.max(0, scrollTop);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    });
  }, []);

  const restorePaginationAnchor = useCallback(() => {
    const scrollEl = scrollRef.current;
    const anchor = paginationAnchorRef.current;
    if (!scrollEl || !anchor) return false;
    const index = keyIndex.get(anchor.key);
    if (index == null) return false;
    virtualizer.scrollToIndex(index, { align: "start" });
    requestAnimationFrame(() => {
      const row = virtualizer.getVirtualItems().find((item) => String(item.key) === anchor.key);
      const nextStart = row?.start;
      if (typeof nextStart === "number") {
        setProgrammaticScrollTop(nextStart - anchor.offsetFromViewportTop);
      }
    });
    paginationAnchorRef.current = null;
    return true;
  }, [keyIndex, setProgrammaticScrollTop, virtualizer]);

  const scrollToLatest = useCallback(() => {
    if (messages.length === 0) return;
    pinnedToBottomRef.current = true;
    programmaticScrollRef.current = true;
    virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
        captureScrollSnapshot();
      });
    });
  }, [captureScrollSnapshot, messages.length, virtualizer]);

  const restoreScrollSnapshot = useCallback(
    (snapshot: ScrollSnapshot) => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return false;

      if (snapshot.atTop) {
        virtualizer.scrollToIndex(0, { align: "start" });
        setProgrammaticScrollTop(0);
        return true;
      }

      if (snapshot.pinnedToBottom) {
        scrollToLatest();
        return true;
      }

      const index = snapshot.anchorKey ? keyIndex.get(snapshot.anchorKey) : undefined;
      if (index != null && snapshot.anchorKey) {
        virtualizer.scrollToIndex(index, { align: "start" });
        let attempts = 0;
        const applyAnchor = () => {
          const row = virtualizer
            .getVirtualItems()
            .find((item) => String(item.key) === snapshot.anchorKey);
          const nextStart = row?.start;
          if (typeof nextStart === "number") {
            setProgrammaticScrollTop(nextStart - snapshot.offsetFromViewportTop);
            return;
          }
          attempts += 1;
          if (attempts < RESTORE_RETRY_FRAMES) requestAnimationFrame(applyAnchor);
          else setProgrammaticScrollTop(snapshot.scrollTop);
        };
        requestAnimationFrame(applyAnchor);
        return true;
      }

      const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      const nextScrollTop = Math.min(
        maxScrollTop,
        Math.max(0, maxScrollTop - snapshot.distanceFromBottom),
      );
      setProgrammaticScrollTop(Number.isFinite(nextScrollTop) ? nextScrollTop : snapshot.scrollTop);
      return true;
    },
    [keyIndex, scrollToLatest, setProgrammaticScrollTop, virtualizer],
  );

  const detachFromBottom = useCallback((force = false) => {
    const el = scrollRef.current;
    if (!el || (!force && isNearBottom(el))) return;
    pinnedToBottomRef.current = false;
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || programmaticScrollRef.current) return;
    pinnedToBottomRef.current = isNearBottom(el);
    scheduleScrollSnapshot();
  }, [scheduleScrollSnapshot]);

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) detachFromBottom(true);
    },
    [detachFromBottom],
  );

  useLayoutEffect(() => {
    const sessionId = scrollKey;
    return () => {
      if (snapshotFrameRef.current != null) {
        cancelAnimationFrame(snapshotFrameRef.current);
        snapshotFrameRef.current = null;
      }
      if (!sessionId) return;
      writeScrollSnapshot(sessionId);
    };
  }, [scrollKey, writeScrollSnapshot]);

  useLayoutEffect(() => {
    restorePaginationAnchor();
  }, [restorePaginationAnchor, messages.length]);

  useLayoutEffect(() => {
    if (!scrollKey || restoredScrollKeyRef.current === scrollKey) return;
    if (messages.length === 0) return;

    const snapshot = scrollSnapshotsRef.current.get(scrollKey);
    if (snapshot) {
      pinnedToBottomRef.current = snapshot.pinnedToBottom;
      restoreScrollSnapshot(snapshot);
    } else {
      scrollToLatest();
    }

    lastMessageKeyRef.current = keys.at(-1) ?? null;
    restoredScrollKeyRef.current = scrollKey;
  }, [keys, messages.length, restoreScrollSnapshot, scrollKey, scrollSnapshotsRef, scrollToLatest]);

  useEffect(() => {
    const lastKey = keys.at(-1) ?? null;
    const previousLastKey = lastMessageKeyRef.current;
    lastMessageKeyRef.current = lastKey;
    if (!lastKey) return;
    if (scrollKey && restoredScrollKeyRef.current !== scrollKey) return;
    if (previousLastKey === null || pinnedToBottomRef.current) {
      scrollToLatest();
      return;
    }
    captureScrollSnapshot();
  }, [captureScrollSnapshot, keys, scrollKey, scrollToLatest]);

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
    capturePaginationAnchor();
    void loadOlder().finally(() => {
      loadInFlightRef.current = false;
    });
  }, [capturePaginationAnchor, hasOlder, isLoadingOlder, loadOlder, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchMove={() => detachFromBottom(true)}
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
    </div>
  );
}
