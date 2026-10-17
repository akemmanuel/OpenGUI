import { useSyncExternalStore } from "react";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet, storageSet } from "@/lib/persistence/storage";

function getSize() {
  const value = Number(storageGet(STORAGE_KEYS.FONT_SIZE));
  return Number.isFinite(value) && value >= 12 && value <= 20 ? value : 16;
}

export function applyStoredFontSize() {
  document.documentElement.style.fontSize = `${getSize()}px`;
}

function subscribe(callback: () => void) {
  const update = () => {
    applyStoredFontSize();
    callback();
  };
  const unsubscribe = onSettingsChange(({ key }) => {
    if (key === STORAGE_KEYS.FONT_SIZE) update();
  });
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEYS.FONT_SIZE || event.key === null) update();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    unsubscribe();
    window.removeEventListener("storage", onStorage);
  };
}

export function useFontSize(): [number, (size: number) => void] {
  const size = useSyncExternalStore(subscribe, getSize, () => 16);
  return [
    size,
    (value) => {
      if (Number.isInteger(value) && value >= 12 && value <= 20)
        storageSet(STORAGE_KEYS.FONT_SIZE, String(value));
    },
  ];
}
