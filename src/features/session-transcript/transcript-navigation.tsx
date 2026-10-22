import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown } from "lucide-react";
import { isNearBottom } from "@/features/session-transcript/use-pinned-scroll";

/** Gap kept above a prompt after jumping to it, so it does not stick to the top edge. */
const PROMPT_TOP_GAP_PX = 12;
const PROMPT_SELECTOR = '[data-transcript-role="user"]';

function promptOffset(container: HTMLElement, prompt: HTMLElement): number {
  return (
    prompt.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  );
}

/** The prompt above or below the current reading position, if any. */
export function findAdjacentPrompt(
  container: HTMLElement,
  direction: "previous" | "next",
): HTMLElement | undefined {
  const position = container.scrollTop + PROMPT_TOP_GAP_PX;
  const prompts = Array.from(container.querySelectorAll<HTMLElement>(PROMPT_SELECTOR));
  if (direction === "next") {
    return prompts.find((prompt) => promptOffset(container, prompt) > position + 4);
  }
  let match: HTMLElement | undefined;
  for (const prompt of prompts) {
    if (promptOffset(container, prompt) < position - 4) match = prompt;
  }
  return match;
}

/** The prompt whose turn is currently being read: the last one above the upper third. */
export function findActivePrompt(container: HTMLElement): HTMLElement | undefined {
  const prompts = Array.from(container.querySelectorAll<HTMLElement>(PROMPT_SELECTOR));
  if (!isNearBottom(container) || container.scrollHeight <= container.clientHeight) {
    const position = container.scrollTop + container.clientHeight / 3;
    let match = prompts[0];
    for (const prompt of prompts) {
      if (promptOffset(container, prompt) <= position) match = prompt;
    }
    return match;
  }
  return prompts.at(-1);
}

/**
 * Jump controls for long transcripts: back to the newest message (flagging
 * output that arrived while the user was reading above), prompt-to-prompt
 * stepping via Alt+↑ / Alt+↓, and direct jumps for the prompt rail.
 */
export function useTranscriptNavigation(input: {
  scrollRef: RefObject<HTMLElement | null>;
  sessionId: string | null;
  contentKey: string;
  scrollToBottom: () => void;
  detachPin: () => void;
}) {
  const { scrollRef, sessionId, contentKey, scrollToBottom, detachPin } = input;
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [hasUnseen, setHasUnseen] = useState(false);
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const lastContentKey = useRef(contentKey);
  const frame = useRef<number | null>(null);

  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const away = !isNearBottom(el);
    setAwayFromBottom(away);
    setActivePromptId(findActivePrompt(el)?.dataset.messageId ?? null);
    if (!away) setHasUnseen(false);
  }, [scrollRef]);

  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      sync();
    });
  }, [sync]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  useEffect(() => {
    setAwayFromBottom(false);
    setHasUnseen(false);
    setActivePromptId(null);
  }, [sessionId]);

  useEffect(() => {
    const changed = lastContentKey.current !== contentKey;
    lastContentKey.current = contentKey;
    const el = scrollRef.current;
    if (!el || !changed) return;
    if (!isNearBottom(el)) {
      setAwayFromBottom(true);
      setHasUnseen(true);
    }
    sync();
  }, [contentKey, scrollRef, sync]);

  const jumpToEnd = useCallback(() => {
    scrollToBottom();
    setAwayFromBottom(false);
    setHasUnseen(false);
  }, [scrollToBottom]);

  const alignPrompt = useCallback(
    (prompt: HTMLElement) => {
      const el = scrollRef.current;
      if (!el) return;
      detachPin();
      el.scrollTop = promptOffset(el, prompt) - PROMPT_TOP_GAP_PX;
      // Rows use content-visibility, so heights above the target can settle after the jump.
      requestAnimationFrame(() => {
        el.scrollTop = promptOffset(el, prompt) - PROMPT_TOP_GAP_PX;
        sync();
      });
    },
    [scrollRef, detachPin, sync],
  );

  const jumpToPrompt = useCallback(
    (direction: "previous" | "next") => {
      const el = scrollRef.current;
      if (!el) return;
      const prompt = findAdjacentPrompt(el, direction);
      if (prompt) alignPrompt(prompt);
      else if (direction === "next") jumpToEnd();
      else if (el.scrollTop > 0) {
        detachPin();
        el.scrollTop = 0;
      }
    },
    [scrollRef, alignPrompt, detachPin, jumpToEnd],
  );

  const jumpToMessage = useCallback(
    (messageId: string) => {
      const prompt = scrollRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (prompt) alignPrompt(prompt);
    },
    [scrollRef, alignPrompt],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey) return;
      const el = scrollRef.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return;
      if (event.key === "ArrowUp") jumpToPrompt("previous");
      else if (event.key === "ArrowDown") jumpToPrompt("next");
      else if (event.key === "End") jumpToEnd();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scrollRef, jumpToPrompt, jumpToEnd]);

  return {
    onScroll,
    awayFromBottom,
    hasUnseen,
    activePromptId,
    jumpToEnd,
    jumpToPrompt,
    jumpToMessage,
  };
}

export function TranscriptNavigation({
  awayFromBottom,
  hasUnseen,
  onJumpToEnd,
}: {
  awayFromBottom: boolean;
  hasUnseen: boolean;
  onJumpToEnd: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="pointer-events-none sticky bottom-0 z-10 h-0">
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-center">
        <button
          type="button"
          onClick={onJumpToEnd}
          tabIndex={awayFromBottom ? 0 : -1}
          aria-hidden={!awayFromBottom}
          title={`${t("messageList.scrollToEnd")} (Alt+End)`}
          className={`flex items-center gap-1.5 rounded-full border border-border/60 bg-background/90 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-all duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none ${
            awayFromBottom
              ? "pointer-events-auto translate-y-0 opacity-100"
              : "pointer-events-none translate-y-2 opacity-0"
          }`}
        >
          {hasUnseen && <span className="size-1.5 rounded-full bg-primary" aria-hidden />}
          <ArrowDown className="size-3.5" aria-hidden />
          {hasUnseen ? t("messageList.newMessages") : t("messageList.scrollToEnd")}
        </button>
      </div>
    </div>
  );
}
