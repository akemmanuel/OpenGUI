import { useCallback } from "react";

interface UseListKeyboardNavigationOptions<T> {
  open: boolean;
  items: readonly T[];
  activeIndex: number;
  setActiveIndex: (updater: (previous: number) => number) => void;
  onSelect: (item: T) => void;
  onDismiss: () => void;
}

export function useListKeyboardNavigation<T>({
  open,
  items,
  activeIndex,
  setActiveIndex,
  onSelect,
  onDismiss,
}: UseListKeyboardNavigationOptions<T>) {
  return useCallback(
    (event: React.KeyboardEvent) => {
      if (!open || items.length === 0) return false;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((previous) => (previous + 1) % items.length);
        return true;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((previous) => (previous - 1 + items.length) % items.length);
        return true;
      }

      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        const item = items[activeIndex];
        if (item !== undefined) onSelect(item);
        return true;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return true;
      }

      return false;
    },
    [open, items, activeIndex, setActiveIndex, onSelect, onDismiss],
  );
}
