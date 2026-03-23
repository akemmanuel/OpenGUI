/** Polyfill localStorage for Bun's test runner (non-browser env). */
export function polyfillLocalStorage() {
	if (typeof globalThis.localStorage === "undefined") {
		const store = new Map<string, string>();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage =
			{
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => store.set(key, String(value)),
				removeItem: (key: string) => store.delete(key),
				clear: () => store.clear(),
				get length() {
					return store.size;
				},
				key: (index: number) => [...store.keys()][index] ?? null,
			} as Storage;
	}
}
