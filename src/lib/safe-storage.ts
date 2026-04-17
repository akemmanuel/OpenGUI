import type {
	SettingsBridge,
	SettingsBridgeChange,
} from "@/types/electron";
import { STORAGE_KEYS } from "@/lib/constants";

const SETTINGS_CHANGED_EVENT = "opengui:settings-changed";
const LEGACY_MIGRATION_FLAG = "__opengui:legacyLocalStorageMigrated";

type SettingsCache = Record<string, string>;
type SettingsChangeDetail = { key: string; value: string | null };

function getElectronSettingsBridge(): SettingsBridge | null {
	if (typeof window === "undefined") return null;
	return window.electronAPI?.settings ?? null;
}

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

let electronSettingsCache: SettingsCache | null = null;
let electronSettingsSubscribed = false;

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
				storageArea:
					typeof localStorage === "undefined" ? null : localStorage,
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

function initElectronSettingsCache(): SettingsCache | null {
	const bridge = getElectronSettingsBridge();
	if (!bridge) return null;
	if (electronSettingsCache === null) {
		electronSettingsCache = bridge.getAllSync();
	}
	if (!electronSettingsSubscribed) {
		electronSettingsSubscribed = true;
		bridge.onDidChange(({ key, value }: SettingsBridgeChange) => {
			const oldValue = electronSettingsCache?.[key] ?? null;
			if (value === null) {
				if (electronSettingsCache) delete electronSettingsCache[key];
			} else {
				electronSettingsCache ??= {};
				electronSettingsCache[key] = value;
			}
			dispatchSettingsChangeEvent(key, value, oldValue);
		});
	}
	return electronSettingsCache;
}

/**
 * Copy all legacy renderer localStorage values into Electron-backed settings.
 * Runs once per machine profile. Safe no-op outside Electron.
 */
export function migrateLegacyLocalStorage(): void {
	const bridge = getElectronSettingsBridge();
	const cache = initElectronSettingsCache();
	if (!bridge || !cache) return;
	if (cache[LEGACY_MIGRATION_FLAG] === "true") return;

	const entries: Record<string, string> = {};
	for (const key of Object.values(STORAGE_KEYS)) {
		const value = safeLocalStorageGet(key);
		if (value === null) continue;
		if (cache[key] == null) entries[key] = value;
	}

	if (Object.keys(entries).length > 0) {
		bridge.mergeSync(entries);
		electronSettingsCache = {
			...electronSettingsCache,
			...entries,
		};
	}

	bridge.setSync(LEGACY_MIGRATION_FLAG, "true");
	electronSettingsCache = {
		...electronSettingsCache,
		[LEGACY_MIGRATION_FLAG]: "true",
	};

	for (const key of Object.values(STORAGE_KEYS)) {
		safeLocalStorageRemove(key);
	}
}

export function onSettingsChange(
	callback: (change: SettingsChangeDetail) => void,
): () => void {
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
	const cache = initElectronSettingsCache();
	if (cache) {
		return cache[key] ?? null;
	}
	return safeLocalStorageGet(key);
}

/** Write raw string to persistent app settings. Silently ignores errors. */
export function storageSet(key: string, value: string): void {
	const bridge = getElectronSettingsBridge();
	const cache = initElectronSettingsCache();
	if (bridge && cache) {
		cache[key] = value;
		void bridge.set(key, value);
		return;
	}
	const oldValue = safeLocalStorageGet(key);
	safeLocalStorageSet(key, value);
	dispatchSettingsChangeEvent(key, value, oldValue);
}

/** Remove key from persistent app settings. Silently ignores errors. */
export function storageRemove(key: string): void {
	const bridge = getElectronSettingsBridge();
	const cache = initElectronSettingsCache();
	if (bridge && cache) {
		delete cache[key];
		void bridge.remove(key);
		return;
	}
	const oldValue = safeLocalStorageGet(key);
	safeLocalStorageRemove(key);
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
export function storageSetOrRemove(
	key: string,
	value: string | null | undefined,
): void {
	if (value) {
		storageSet(key, value);
	} else {
		storageRemove(key);
	}
}

/** Persist JSON value if non-empty, otherwise remove key. */
export function persistOrRemoveJSON(
	key: string,
	value: unknown,
	isEmpty: boolean,
): void {
	if (isEmpty) {
		storageRemove(key);
	} else {
		storageSetJSON(key, value);
	}
}
