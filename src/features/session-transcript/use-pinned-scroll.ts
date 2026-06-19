import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { NEAR_BOTTOM_PX } from "@/lib/constants";

function distanceFromBottom(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

function isNearBottom(element: HTMLElement): boolean {
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (maxScrollTop <= NEAR_BOTTOM_PX) return true;
  return distanceFromBottom(element) <= NEAR_BOTTOM_PX;
}

function pinToBottom(element: HTMLElement): void {
  const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (element.scrollTop !== maxTop) element.scrollTop = maxTop;
}

export function usePinnedScroll(input: {
  sessionId: string | null;
  /** Changes when transcript content length/revision changes (e.g. message count + busy). */
  contentKey: string;
  pinWhenNearBottom: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const programmaticRef = useRef(false);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const markProgrammatic = useCallback(() => {
    programmaticRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        programmaticRef.current = false;
      });
    });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || programmaticRef.current) return;
    pinnedRef.current = isNearBottom(el);
  }, []);

  const detachPin = useCallback(() => {
    pinnedRef.current = false;
  }, []);

  const capturePrependAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    prependAnchorRef.current = {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
  }, []);

  useLayoutEffect(() => {
    pinnedRef.current = true;
    prependAnchorRef.current = null;
    const el = scrollRef.current;
    if (!el) return;
    markProgrammatic();
    pinToBottom(el);
  }, [input.sessionId, markProgrammatic]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prependAnchorRef.current;
    if (!el || !anchor) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    if (delta > 0) {
      markProgrammatic();
      el.scrollTop = anchor.scrollTop + delta;
    }
    prependAnchorRef.current = null;
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (input.pinWhenNearBottom && pinnedRef.current) {
      markProgrammatic();
      pinToBottom(el);
    }
  }, [input.contentKey, input.pinWhenNearBottom, markProgrammatic]);

  return {
    scrollRef,
    onScroll,
    detachPin,
    capturePrependAnchor,
    isPinned: () => pinnedRef.current,
  };
}
