import { useEffect } from "react";

export type KeyboardShortcut = (event: KeyboardEvent) => boolean | void;

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function isInDialog(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('[role="dialog"]'));
}

export function isModKey(event: KeyboardEvent) {
  return event.metaKey || event.ctrlKey;
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      for (const shortcut of shortcuts) {
        if (shortcut(event) === true) break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts]);
}
