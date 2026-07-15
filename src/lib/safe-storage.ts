import type { SettingsBridgeChange } from "@/types/electron";
import { getSettingsBridge } from "@/runtime/settings";

const SETTINGS_CHANGED_EVENT = "opengui:settings-changed";

type SettingsCache = Record<string, string>;
type SettingsChangeDetail = { key: string; value: string | null };

function safeLocalStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full or unavailable */
  }
}

function safeLocalStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

let settingsCache: SettingsCache | null = null;
let settingsSubscribed = false;

function dispatchSettingsChangeEvent(
  key: string,
  newValue: string | null,
  oldValue: string | null,
): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue,
        oldValue,
        storageArea: typeof localStorage === "undefined" ? null : localStorage,
      }),
    );
  } catch {
    // Ignore environments that cannot construct StorageEvent.
  }
  window.dispatchEvent(
    new CustomEvent<SettingsChangeDetail>(SETTINGS_CHANGED_EVENT, {
      detail: { key, value: newValue },
    }),
  );
}

function mirrorSettingsToLocalStorage(entries: SettingsCache) {
  for (const [key, value] of Object.entries(entries)) {
    safeLocalStorageSet(key, value);
  }
}

function initSettingsCache(): SettingsCache | null {
  const bridge = getSettingsBridge();
  if (!bridge) return null;

  if (settingsCache === null) {
    settingsCache = bridge.getAllSync();
    mirrorSettingsToLocalStorage(settingsCache);
  }

  if (!settingsSubscribed) {
    settingsSubscribed = true;
    bridge.onDidChange(({ key, value }: SettingsBridgeChange) => {
      const oldValue = settingsCache?.[key] ?? null;
      if (value === null) {
        if (settingsCache) delete settingsCache[key];
        safeLocalStorageRemove(key);
      } else {
        settingsCache ??= {};
        settingsCache[key] = value;
        safeLocalStorageSet(key, value);
      }
      dispatchSettingsChangeEvent(key, value, oldValue);
    });
  }

  return settingsCache;
}

export function onSettingsChange(callback: (change: SettingsChangeDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<SettingsChangeDetail>).detail;
    if (detail?.key) callback(detail);
  };
  window.addEventListener(SETTINGS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handler);
}

/** Read raw string from persistent app settings. Returns `null` if missing or on error. */
export function storageGet(key: string): string | null {
  const cache = initSettingsCache();
  if (cache) return cache[key] ?? null;
  return safeLocalStorageGet(key);
}

/** Write raw string to persistent app settings. Silently ignores errors. */
export function storageSet(key: string, value: string): void {
  const bridge = getSettingsBridge();
  const cache = initSettingsCache();
  const oldValue = cache?.[key] ?? safeLocalStorageGet(key);

  safeLocalStorageSet(key, value);
  if (cache) cache[key] = value;

  if (bridge) {
    void bridge.set(key, value);
    return;
  }

  dispatchSettingsChangeEvent(key, value, oldValue);
}

/** Remove key from persistent app settings. Silently ignores errors. */
export function storageRemove(key: string): void {
  const bridge = getSettingsBridge();
  const cache = initSettingsCache();
  const oldValue = cache?.[key] ?? safeLocalStorageGet(key);

  safeLocalStorageRemove(key);
  if (cache) delete cache[key];

  if (bridge) {
    void bridge.remove(key);
    return;
  }

  dispatchSettingsChangeEvent(key, null, oldValue);
}

/**
 * Parse JSON value from persistent app settings.
 * Returns `null` if key is missing, JSON is malformed, or on error.
 */
export function storageParsed<T>(key: string): T | null {
  const raw = storageGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Write JSON-serialisable value to persistent app settings. */
export function storageSetJSON(key: string, value: unknown): void {
  storageSet(key, JSON.stringify(value));
}

/** Conditionally set or remove key. */
export function storageSetOrRemove(key: string, value: string | null | undefined): void {
  if (value) {
    storageSet(key, value);
  } else {
    storageRemove(key);
  }
}

/** Persist JSON value if non-empty, otherwise remove key. */
export function persistOrRemoveJSON(key: string, value: unknown, isEmpty: boolean): void {
  if (isEmpty) {
    storageRemove(key);
  } else {
    storageSetJSON(key, value);
  }
}
