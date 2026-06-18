import { useEffect, useMemo, useRef, useState } from "react";
import type { useBackendCapabilities } from "@/hooks/use-agent-backend";
import type { QueueMode, useActions } from "@/hooks/use-agent-state";
import {
  isEditableTarget,
  isInDialog,
  isModKey,
  useKeyboardShortcuts,
  type KeyboardShortcut,
} from "@/hooks/use-keyboard-shortcuts";

type Capabilities = ReturnType<typeof useBackendCapabilities>;
type Actions = ReturnType<typeof useActions>;

interface UseAppKeyboardShortcutsParams {
  capabilities: Capabilities;
  isBusy: boolean;
  abortSession: Actions["abortSession"];
  cycleVariant: Actions["cycleVariant"];
  revertVariant: Actions["revertVariant"];
  unrevert: Actions["unrevert"];
  revertToLastMessage: () => void;
}

export function useAppKeyboardShortcuts({
  capabilities,
  isBusy,
  abortSession,
  cycleVariant,
  revertVariant,
  unrevert,
  revertToLastMessage,
}: UseAppKeyboardShortcutsParams) {
  const lastEscapeAtRef = useRef(0);
  const [queueMode, setQueueMode] = useState<QueueMode>("queue");

  const keyboardShortcuts = useMemo<KeyboardShortcut[]>(
    () => [
      (event) => {
        if (!capabilities?.revert) return;
        if (event.key.toLowerCase() !== "z" || !isModKey(event)) return;
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        if (event.shiftKey) void unrevert();
        else revertToLastMessage();
        return true;
      },
      (event) => {
        if (!capabilities?.models) return;
        if (event.key.toLowerCase() !== "t" || !isModKey(event)) return;
        event.preventDefault();
        if (event.shiftKey) revertVariant();
        else cycleVariant();
        return true;
      },
      (event) => {
        if (event.key.toLowerCase() !== "k" || !isModKey(event)) return;
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("focus-sidebar-search"));
        return true;
      },
      (event) => {
        if (event.key !== "Escape" || event.repeat) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (isInDialog(event.target)) return;

        const now = Date.now();
        const isDoubleEscape = now - lastEscapeAtRef.current <= 450;
        lastEscapeAtRef.current = now;
        if (!isDoubleEscape || !isBusy) return;

        event.preventDefault();
        void abortSession();
        return true;
      },
      (event) => {
        if (event.key !== "d" || !isModKey(event)) return;
        if (!isBusy || isInDialog(event.target)) return;
        event.preventDefault();
        setQueueMode((previous) => (previous === "queue" ? "after-part" : "queue"));
        return true;
      },
    ],
    [
      capabilities?.models,
      capabilities?.revert,
      revertToLastMessage,
      unrevert,
      cycleVariant,
      revertVariant,
      abortSession,
      isBusy,
    ],
  );
  useKeyboardShortcuts(keyboardShortcuts);

  useModelSelectorChord();

  return { queueMode, setQueueMode };
}

function useModelSelectorChord() {
  useEffect(() => {
    let chordActive = false;
    let chordTimer: ReturnType<typeof setTimeout> | null = null;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "x" && (event.ctrlKey || event.metaKey)) {
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;
        event.preventDefault();
        chordActive = true;
        if (chordTimer) clearTimeout(chordTimer);
        chordTimer = setTimeout(() => {
          chordActive = false;
          chordTimer = null;
        }, 2000);
      } else if (chordActive && event.key.toLowerCase() === "m") {
        event.preventDefault();
        chordActive = false;
        if (chordTimer) {
          clearTimeout(chordTimer);
          chordTimer = null;
        }
        window.dispatchEvent(new CustomEvent("open-model-selector"));
      } else if (chordActive) {
        chordActive = false;
        if (chordTimer) {
          clearTimeout(chordTimer);
          chordTimer = null;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (chordTimer) clearTimeout(chordTimer);
    };
  }, []);
}
