import { useSyncExternalStore } from "react";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet, storageSet } from "@/lib/persistence/storage";

export const SIDEBAR_DEFAULT_WIDTH_PX = 256;
export const SIDEBAR_MIN_WIDTH_PX = 200;
export const SIDEBAR_MAX_WIDTH_PX = 480;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH_PX;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, width)));
}

function getSidebarWidth(): number {
  const stored = storageGet(STORAGE_KEYS.SIDEBAR_WIDTH);
  return stored ? clampSidebarWidth(Number(stored)) : SIDEBAR_DEFAULT_WIDTH_PX;
}

function subscribe(callback: () => void): () => void {
  const unsubscribe = onSettingsChange(({ key }) => {
    if (key === STORAGE_KEYS.SIDEBAR_WIDTH) callback();
  });
  // Browser storage events from other tabs are not dispatched via onSettingsChange.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEYS.SIDEBAR_WIDTH) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    unsubscribe();
    window.removeEventListener("storage", onStorage);
  };
}

/** Desktop sidebar width in px, persisted across restarts. */
export function useSidebarWidth(): [number, (value: number) => void] {
  const width = useSyncExternalStore(subscribe, getSidebarWidth, () => SIDEBAR_DEFAULT_WIDTH_PX);
  return [
    width,
    (value) => storageSet(STORAGE_KEYS.SIDEBAR_WIDTH, String(clampSidebarWidth(value))),
  ];
}
