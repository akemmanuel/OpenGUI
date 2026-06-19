import * as React from "react";
import type { MessageEntry } from "@/hooks/use-agent-state";
import { canNavigateHistoryAtCursor } from "@/lib/prompt-history";

export function usePromptHistoryNavigation({
  messages,
  userHistory: providedUserHistory,
  value,
  setValue,
  imageCount,
  draftKey,
  textareaRef,
}: {
  messages?: MessageEntry[];
  userHistory?: readonly string[];
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  imageCount: number;
  draftKey: string | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [historyIndex, setHistoryIndex] = React.useState(-1);
  const [savedDraft, setSavedDraft] = React.useState("");
  const isApplyingHistoryRef = React.useRef(false);

  const computedUserHistory = React.useMemo(
    () =>
      (messages ?? [])
        .filter((m) => m.info.role === "user")
        .map((m) =>
          m.parts
            .filter((p) => p.type === "text")
            .map((p) => ("text" in p ? p.text : ""))
            .join(""),
        )
        .filter((text) => text.length > 0)
        .reverse(),
    [messages],
  );
  const userHistory = providedUserHistory ?? computedUserHistory;

  React.useEffect(() => {
    setHistoryIndex(-1);
    setSavedDraft("");
  }, [draftKey]);

  const resetHistory = React.useCallback(() => {
    setHistoryIndex(-1);
    setSavedDraft("");
  }, []);

  const noteManualInput = React.useCallback(() => {
    if (isApplyingHistoryRef.current) {
      isApplyingHistoryRef.current = false;
      return;
    }
    if (historyIndex >= 0) resetHistory();
  }, [historyIndex, resetHistory]);

  const handleHistoryKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
      if (e.altKey || e.ctrlKey || e.metaKey) return false;

      const textarea = textareaRef.current;
      if (!textarea) return false;

      const direction = e.key === "ArrowUp" ? "up" : "down";
      const inHistory = historyIndex >= 0;
      const hasDraftContent = value.length > 0 || imageCount > 0;

      if (!inHistory && hasDraftContent) return false;
      if (!canNavigateHistoryAtCursor(direction, value, textarea.selectionStart, inHistory)) {
        return false;
      }

      if (direction === "up") {
        if (userHistory.length === 0) return false;
        if (historyIndex === -1) {
          const entry = userHistory[0];
          if (entry === undefined) return false;
          setSavedDraft(value);
          isApplyingHistoryRef.current = true;
          setHistoryIndex(0);
          setValue(entry);
        } else if (historyIndex < userHistory.length - 1) {
          const next = historyIndex + 1;
          const entry = userHistory[next];
          if (entry === undefined) return false;
          isApplyingHistoryRef.current = true;
          setHistoryIndex(next);
          setValue(entry);
        } else {
          return false;
        }
      } else if (historyIndex <= 0) {
        isApplyingHistoryRef.current = true;
        setHistoryIndex(-1);
        setValue(savedDraft);
      } else {
        const next = historyIndex - 1;
        const entry = userHistory[next];
        if (entry === undefined) return false;
        isApplyingHistoryRef.current = true;
        setHistoryIndex(next);
        setValue(entry);
      }

      e.preventDefault();
      return true;
    },
    [historyIndex, imageCount, savedDraft, setValue, textareaRef, userHistory, value],
  );

  return { handleHistoryKeyDown, noteManualInput, resetHistory };
}
