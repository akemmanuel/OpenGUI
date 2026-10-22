import { useSyncExternalStore } from "react";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet, storageSet } from "@/lib/persistence/storage";

export type ChatWidth = number;

function getChatWidth(): ChatWidth {
  const stored = storageGet(STORAGE_KEYS.CHAT_WIDTH);
  if (stored === "full") return 100;
  const value = Number(stored);
  return Number.isInteger(value) && value >= 40 && value <= 100 ? value : 70;
}

function subscribe(callback: () => void): () => void {
  const unsubscribe = onSettingsChange(({ key }) => {
    if (key === STORAGE_KEYS.CHAT_WIDTH) callback();
  });
  // Browser storage events from other tabs are not dispatched via onSettingsChange.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEYS.CHAT_WIDTH || event.key === null) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    unsubscribe();
    window.removeEventListener("storage", onStorage);
  };
}

export function useChatWidth(): [ChatWidth, (value: ChatWidth) => void] {
  const width = useSyncExternalStore(subscribe, getChatWidth, (): ChatWidth => 70);
  return [
    width,
    (value) => {
      if (Number.isInteger(value) && value >= 40 && value <= 100) {
        storageSet(STORAGE_KEYS.CHAT_WIDTH, String(value));
      }
    },
  ];
}
