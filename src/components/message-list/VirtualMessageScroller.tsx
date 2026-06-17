import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
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
const USER_SCROLL_INTENT_WINDOW_MS = 750;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

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

export function shouldLoadOlderMessages({
  firstIndex,
  hasOlder,
  isLoadingOlder,
  loadInFlight,
}: {
  firstIndex: number | undefined;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  loadInFlight: boolean;
}) {
  return (
    firstIndex != null &&
    firstIndex <= LOAD_OLDER_THRESHOLD_INDEX &&
    hasOlder &&
    !isLoadingOlder &&
    !loadInFlight
  );
}

export function getScrollSnapshotFlags(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  wasPinnedToBottom: boolean,
) {
  const pinnedToBottom = wasPinnedToBottom || isNearBottom(element);
  return {
    atTop: !pinnedToBottom && isAtTop(element),
    pinnedToBottom,
  };
}

/** Instant pin: DOM bottom (includes trailing UI below the virtual spacer). */
function pinScrollToBottom(scrollEl: HTMLElement) {
  const maxTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  if (scrollEl.scrollTop !== maxTop) scrollEl.scrollTop = maxTop;
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
  const userScrollIntentUntilRef = useRef(0);
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
    useAnimationFrameWithResizeObserver: false,
  });

  const endProgrammaticScrollSoon = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    });
  }, []);

  const writeScrollSnapshot = useCallback(
    (sessionId: string) => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;
      const first = virtualizer.getVirtualItems()[0];
      const { atTop, pinnedToBottom } = getScrollSnapshotFlags(scrollEl, pinnedToBottomRef.current);
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

  const setProgrammaticScrollTop = useCallback(
    (scrollTop: number) => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;
      programmaticScrollRef.current = true;
      scrollEl.scrollTop = Math.max(0, scrollTop);
      endProgrammaticScrollSoon();
    },
    [endProgrammaticScrollSoon],
  );

  const maintainPinIfNeeded = useCallback(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl || !pinnedToBottomRef.current || messages.length === 0) return;
    if (distanceFromBottom(scrollEl) <= 0.5) return;
    programmaticScrollRef.current = true;
    pinScrollToBottom(scrollEl);
    endProgrammaticScrollSoon();
  }, [endProgrammaticScrollSoon, messages.length]);

  const capturePaginationAnchor = useCallback(() => {
    const scrollEl = scrollRef.current;
    const first = virtualizer.getVirtualItems()[0];
    if (!scrollEl || !first) return;
    paginationAnchorRef.current = {
      key: String(first.key),
      offsetFromViewportTop: first.start - scrollEl.scrollTop,
    };
  }, [virtualizer]);

  const releaseOlderLoadLock = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        loadInFlightRef.current = false;
      });
    });
  }, []);

  const maybeLoadOlder = useCallback(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl || pinnedToBottomRef.current || !isAtTop(scrollEl)) return;

    const firstIndex = virtualizer.getVirtualItems()[0]?.index;
    if (
      !shouldLoadOlderMessages({
        firstIndex,
        hasOlder,
        isLoadingOlder,
        loadInFlight: loadInFlightRef.current,
      })
    ) {
      return;
    }

    loadInFlightRef.current = true;
    capturePaginationAnchor();
    void loadOlder().finally(releaseOlderLoadLock);
  }, [
    capturePaginationAnchor,
    hasOlder,
    isLoadingOlder,
    loadOlder,
    releaseOlderLoadLock,
    virtualizer,
  ]);

  const restorePaginationAnchor = useCallback(() => {
    const scrollEl = scrollRef.current;
    const anchor = paginationAnchorRef.current;
    if (!scrollEl || !anchor) return false;
    const index = keyIndex.get(anchor.key);
    if (index == null) return false;
    virtualizer.scrollToIndex(index, { align: "start", behavior: "auto" });
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

  const restoreScrollSnapshot = useCallback(
    (snapshot: ScrollSnapshot) => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return false;

      if (snapshot.pinnedToBottom) {
        pinnedToBottomRef.current = true;
        programmaticScrollRef.current = true;
        pinScrollToBottom(scrollEl);
        endProgrammaticScrollSoon();
        captureScrollSnapshot();
        return true;
      }

      if (snapshot.atTop) {
        virtualizer.scrollToIndex(0, { align: "start", behavior: "auto" });
        setProgrammaticScrollTop(0);
        return true;
      }

      const index = snapshot.anchorKey ? keyIndex.get(snapshot.anchorKey) : undefined;
      if (index != null && snapshot.anchorKey) {
        virtualizer.scrollToIndex(index, { align: "start", behavior: "auto" });
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

      const maxTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      const nextScrollTop = Math.min(maxTop, Math.max(0, maxTop - snapshot.distanceFromBottom));
      setProgrammaticScrollTop(Number.isFinite(nextScrollTop) ? nextScrollTop : snapshot.scrollTop);
      return true;
    },
    [
      captureScrollSnapshot,
      endProgrammaticScrollSoon,
      keyIndex,
      setProgrammaticScrollTop,
      virtualizer,
    ],
  );

  const detachFromBottom = useCallback((force = false) => {
    const el = scrollRef.current;
    if (!el || (!force && isNearBottom(el))) return;
    pinnedToBottomRef.current = false;
  }, []);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);

  const hasRecentUserScrollIntent = useCallback(
    () => Date.now() <= userScrollIntentUntilRef.current,
    [],
  );

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || programmaticScrollRef.current) return;
    if (isNearBottom(el)) pinnedToBottomRef.current = true;
    else if (hasRecentUserScrollIntent()) pinnedToBottomRef.current = false;
    scheduleScrollSnapshot();
    requestAnimationFrame(maybeLoadOlder);
  }, [hasRecentUserScrollIntent, maybeLoadOlder, scheduleScrollSnapshot]);

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      markUserScrollIntent();
      if (event.deltaY < 0) detachFromBottom(true);
      requestAnimationFrame(maybeLoadOlder);
    },
    [detachFromBottom, markUserScrollIntent, maybeLoadOlder],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      const scrollbarWidth = el.offsetWidth - el.clientWidth;
      if (scrollbarWidth <= 0) return;
      const rect = el.getBoundingClientRect();
      if (event.clientX >= rect.right - scrollbarWidth - 2) markUserScrollIntent();
    },
    [markUserScrollIntent],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (SCROLL_KEYS.has(event.key)) markUserScrollIntent();
    },
    [markUserScrollIntent],
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
      pinnedToBottomRef.current = true;
      maintainPinIfNeeded();
    }

    lastMessageKeyRef.current = keys.at(-1) ?? null;
    restoredScrollKeyRef.current = scrollKey;
  }, [
    keys,
    maintainPinIfNeeded,
    messages.length,
    restoreScrollSnapshot,
    scrollKey,
    scrollSnapshotsRef,
  ]);

  const virtualItems = virtualizer.getVirtualItems();
  const firstVirtualIndex = virtualItems[0]?.index;
  const totalSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    if (!scrollKey || restoredScrollKeyRef.current !== scrollKey) return;

    const lastKey = keys.at(-1) ?? null;
    lastMessageKeyRef.current = lastKey;
    if (!lastKey) return;

    if (!pinnedToBottomRef.current) {
      captureScrollSnapshot();
      return;
    }

    maintainPinIfNeeded();
  }, [captureScrollSnapshot, keys, maintainPinIfNeeded, scrollKey, totalSize]);

  useEffect(() => {
    maybeLoadOlder();
  }, [firstVirtualIndex, maybeLoadOlder]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onTouchStart={markUserScrollIntent}
      onTouchMove={() => {
        markUserScrollIntent();
        detachFromBottom(true);
        requestAnimationFrame(maybeLoadOlder);
      }}
      className="relative flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 [overflow-anchor:none]"
    >
      <div className="max-w-[640px] mx-auto">
        {isLoadingOlder && (
          <div className="flex items-center justify-center py-3">
            <Spinner className="size-4 text-muted-foreground" />
          </div>
        )}
        <div className="relative w-full" style={{ height: totalSize }}>
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
