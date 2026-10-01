import { useSyncExternalStore } from "react";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet, storageSet } from "@/lib/persistence/storage";

export type ChatWidth = "standard" | "full";

function getChatWidth(): ChatWidth {
  return storageGet(STORAGE_KEYS.CHAT_WIDTH) === "full" ? "full" : "standard";
}

function subscribe(callback: () => void): () => void {
  const unsubscribe = onSettingsChange(({ key }) => {
    if (key === STORAGE_KEYS.CHAT_WIDTH) callback();
  });
  // Browser storage events from other tabs are not dispatched via onSettingsChange.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEYS.CHAT_WIDTH) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    unsubscribe();
    window.removeEventListener("storage", onStorage);
  };
}

export function useChatWidth(): [ChatWidth, (value: ChatWidth) => void] {
  const width = useSyncExternalStore(subscribe, getChatWidth, (): ChatWidth => "standard");
  return [width, (value) => storageSet(STORAGE_KEYS.CHAT_WIDTH, value)];
}
