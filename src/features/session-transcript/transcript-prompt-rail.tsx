import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PromptMarker } from "@/features/session-transcript/transcript-prompt-markers";

/**
 * Minimap of the user's prompts along the left edge of the transcript: one line
 * per prompt, the current one highlighted, with a preview card on hover.
 */
export function TranscriptPromptRail({
  markers,
  activeId,
  onSelect,
}: {
  markers: readonly PromptMarker[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ marker: PromptMarker; top: number } | null>(null);

  useEffect(() => {
    const list = listRef.current;
    const active = activeId
      ? list?.querySelector<HTMLElement>(`[data-marker-id="${CSS.escape(activeId)}"]`)
      : null;
    if (!list || !active) return;
    if (active.offsetTop < list.scrollTop) list.scrollTop = active.offsetTop;
    else if (active.offsetTop + active.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = active.offsetTop + active.offsetHeight - list.clientHeight;
    }
  }, [activeId]);

  const showPreview = (marker: PromptMarker, target: HTMLElement) => {
    const nav = navRef.current;
    if (!nav) return;
    const rect = target.getBoundingClientRect();
    setPreview({ marker, top: rect.top + rect.height / 2 - nav.getBoundingClientRect().top });
  };

  return (
    <nav
      ref={navRef}
      aria-label={t("messageList.promptNavigation")}
      className="pointer-events-none absolute inset-y-0 left-1 z-20 flex items-center"
      onMouseLeave={() => setPreview(null)}
    >
      <div
        ref={listRef}
        className="pointer-events-auto flex max-h-[60%] flex-col overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {markers.map((marker, index) => {
          const active = marker.id === activeId;
          return (
            <button
              key={marker.id}
              type="button"
              data-marker-id={marker.id}
              aria-current={active ? "location" : undefined}
              aria-label={marker.prompt || t("messageList.promptNumber", { number: index + 1 })}
              onClick={() => onSelect(marker.id)}
              onMouseEnter={(event) => showPreview(marker, event.currentTarget)}
              onFocus={(event) => showPreview(marker, event.currentTarget)}
              onBlur={() => setPreview(null)}
              className="group flex h-2 w-6 shrink-0 items-center rounded-sm pl-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span
                className={`h-0.5 rounded-full transition-all duration-150 motion-reduce:transition-none ${
                  active
                    ? "w-4 bg-foreground"
                    : "w-2.5 bg-muted-foreground/40 group-hover:w-3.5 group-hover:bg-muted-foreground"
                }`}
              />
            </button>
          );
        })}
      </div>
      {preview && (
        <div
          role="tooltip"
          className="pointer-events-none absolute left-8 w-72 -translate-y-1/2 rounded-xl border border-border/60 bg-popover/95 px-3 py-2 text-popover-foreground shadow-lg backdrop-blur"
          style={{ top: preview.top }}
        >
          <div className="line-clamp-1 text-sm font-medium">
            {preview.marker.prompt ||
              t("messageList.promptNumber", {
                number: markers.indexOf(preview.marker) + 1,
              })}
          </div>
          {preview.marker.reply && (
            <div className="mt-1 line-clamp-3 text-xs text-muted-foreground">
              {preview.marker.reply}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
