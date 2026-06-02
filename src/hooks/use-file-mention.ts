import * as React from "react";

export function findFileMentionTrigger(
  value: string,
  cursorPos: number,
): { anchor: number; query: string } | null {
  const textBeforeCursor = value.slice(0, cursorPos);
  for (let index = textBeforeCursor.length - 1; index >= 0; index--) {
    const ch = textBeforeCursor[index];
    if (ch === " " || ch === "\n" || ch === "\t") break;
    if (ch === "@") {
      if (index === 0 || /\s/.test(textBeforeCursor[index - 1] ?? "")) {
        return { anchor: index, query: textBeforeCursor.slice(index + 1) };
      }
      break;
    }
  }
  return null;
}

export function useFileMention({
  value,
  setValue,
  textareaRef,
  findFiles,
  getActiveDirectory,
}: {
  value: string;
  setValue: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  findFiles: (directory: string | null, query: string) => Promise<string[]>;
  getActiveDirectory: () => string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [results, setResults] = React.useState<string[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [emptyMessage, setEmptyMessage] = React.useState<string | null>(null);
  const anchorRef = React.useRef(-1);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDebounce = React.useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  React.useEffect(() => clearDebounce, [clearDebounce]);

  const dismiss = React.useCallback(() => {
    setOpen(false);
    setResults([]);
    setEmptyMessage(null);
    anchorRef.current = -1;
    clearDebounce();
  }, [clearDebounce]);

  const reset = React.useCallback(() => {
    dismiss();
    setActiveIndex(0);
    setLoading(false);
  }, [dismiss]);

  const updateForInput = React.useCallback(
    (newValue: string, cursorPos: number) => {
      const trigger = findFileMentionTrigger(newValue, cursorPos);
      if (!trigger) {
        dismiss();
        return;
      }

      const { anchor, query } = trigger;
      anchorRef.current = anchor;
      setActiveIndex(0);
      setOpen(true);
      clearDebounce();

      if (query.trim().length === 0) {
        setLoading(false);
        setResults([]);
        setEmptyMessage("Type to search files");
        return;
      }

      setEmptyMessage(null);
      setLoading(true);
      debounceRef.current = setTimeout(async () => {
        try {
          const activeDir = getActiveDirectory();
          const found = await findFiles(activeDir, query);
          setResults(found.slice(0, 20));
          setEmptyMessage(found.length === 0 ? "No matching files" : null);
        } catch {
          setResults([]);
          setEmptyMessage("File search failed");
        } finally {
          setLoading(false);
        }
      }, 150);
    },
    [clearDebounce, dismiss, findFiles, getActiveDirectory],
  );

  const select = React.useCallback(
    (filePath: string) => {
      const anchor = anchorRef.current;
      if (anchor < 0) return;
      const textarea = textareaRef.current;
      const cursorPos = textarea?.selectionStart ?? value.length;
      const before = value.slice(0, anchor);
      const after = value.slice(cursorPos);
      const insertion = `@${filePath} `;
      const newValue = before + insertion + after;

      setValue(newValue);
      setOpen(false);
      setResults([]);
      setEmptyMessage(null);
      anchorRef.current = -1;

      const newCursorPos = before.length + insertion.length;
      requestAnimationFrame(() => {
        textarea?.focus();
        textarea?.setSelectionRange(newCursorPos, newCursorPos);
      });
    },
    [setValue, textareaRef, value],
  );

  return {
    open,
    results,
    activeIndex,
    setActiveIndex,
    loading,
    emptyMessage,
    updateForInput,
    select,
    dismiss,
    reset,
  };
}
