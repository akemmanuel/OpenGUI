import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

const HIDE_AFTER_SCROLL_MS = 1200;

/** Creation time of the first transcript row still visible at the top of the viewport. */
export function topVisibleTimestamp(container: HTMLElement): number | undefined {
  const top = container.getBoundingClientRect().top;
  for (const row of container.querySelectorAll<HTMLElement>("[data-created-at]")) {
    if (row.getBoundingClientRect().bottom <= top + 1) continue;
    const created = Number(row.dataset.createdAt);
    return Number.isFinite(created) && created > 0 ? created : undefined;
  }
  return undefined;
}

/**
 * Floating date and time of the conversation position while scrolling (#164).
 * Follows the visible rows rather than the clock, and fades after scrolling stops.
 */
export function useScrollTimeIndicator(scrollRef: RefObject<HTMLElement | null>) {
  const { i18n } = useTranslation();
  const [timestamp, setTimestamp] = useState<number>();
  const [visible, setVisible] = useState(false);
  const frame = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const container = scrollRef.current;
      if (!container) return;
      const next = container.scrollTop > 0 ? topVisibleTimestamp(container) : undefined;
      setTimestamp(next);
      setVisible(next !== undefined);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setVisible(false), HIDE_AFTER_SCROLL_MS);
    });
  }, [scrollRef]);

  const label =
    timestamp === undefined
      ? undefined
      : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(
          timestamp,
        );

  return { onScroll, label, visible };
}

export function ScrollTimeIndicator({ label, visible }: { label?: string; visible: boolean }) {
  return (
    <div
      className="pointer-events-none sticky top-0 z-10 flex h-0 items-start justify-center"
      aria-hidden
    >
      <span
        className={`mt-1 rounded-full border border-border/60 bg-background/90 px-3 py-1 text-xs tabular-nums text-muted-foreground shadow-sm backdrop-blur transition-opacity duration-300 motion-reduce:transition-none ${
          visible && label ? "opacity-100" : "opacity-0"
        }`}
      >
        {label}
      </span>
    </div>
  );
}
