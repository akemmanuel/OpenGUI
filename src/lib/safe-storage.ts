/**
 * Type-safe localStorage helpers that never throw.
 *
 * Every read/write is wrapped in a try-catch so callers don't need to
 * repeat the same `try { localStorage.… } catch { /* ignore * / }` pattern.
 */

/** Read a raw string from localStorage. Returns `null` if missing or on error. */
export function storageGet(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

/** Write a raw string to localStorage. Silently ignores errors. */
export function storageSet(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* storage full or unavailable */
	}
}

/** Remove a key from localStorage. Silently ignores errors. */
export function storageRemove(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

/**
 * Parse a JSON value from localStorage.
 * Returns `null` if the key is missing, the JSON is malformed, or on error.
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

/**
 * Write a JSON-serialisable value to localStorage.
 * Silently ignores errors.
 */
export function storageSetJSON(key: string, value: unknown): void {
	storageSet(key, JSON.stringify(value));
}

/**
 * Conditionally set or remove a key.
 * If `value` is truthy, write it; otherwise remove the key.
 */
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
