import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	storageGet,
	storageParsed,
	storageRemove,
	storageSet,
	storageSetJSON,
	storageSetOrRemove,
} from "../safe-storage";

// Polyfill localStorage for Bun's test runner (which runs in a non-browser env)
beforeAll(() => {
	if (typeof globalThis.localStorage === "undefined") {
		const store = new Map<string, string>();
		// biome-ignore lint/suspicious/noExplicitAny: lightweight test polyfill
		(globalThis as any).localStorage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, String(value)),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
			get length() {
				return store.size;
			},
			key: (index: number) => [...store.keys()][index] ?? null,
		};
	}
});

// Clean up after each test
afterEach(() => {
	localStorage.clear();
});

describe("storageGet", () => {
	test("returns stored value", () => {
		localStorage.setItem("key", "value");
		expect(storageGet("key")).toBe("value");
	});

	test("returns null for missing key", () => {
		expect(storageGet("missing")).toBeNull();
	});
});

describe("storageSet", () => {
	test("stores a value", () => {
		storageSet("key", "value");
		expect(localStorage.getItem("key")).toBe("value");
	});
});

describe("storageRemove", () => {
	test("removes a key", () => {
		localStorage.setItem("key", "value");
		storageRemove("key");
		expect(localStorage.getItem("key")).toBeNull();
	});

	test("does nothing for missing key", () => {
		storageRemove("missing"); // should not throw
	});
});

describe("storageParsed", () => {
	test("parses JSON from storage", () => {
		localStorage.setItem("obj", JSON.stringify({ a: 1 }));
		expect(storageParsed<{ a: number }>("obj")).toEqual({ a: 1 });
	});

	test("returns null for missing key", () => {
		expect(storageParsed("missing")).toBeNull();
	});

	test("returns null for malformed JSON", () => {
		localStorage.setItem("bad", "not-json{");
		expect(storageParsed("bad")).toBeNull();
	});

	test("parses arrays", () => {
		localStorage.setItem("arr", JSON.stringify([1, 2, 3]));
		expect(storageParsed<number[]>("arr")).toEqual([1, 2, 3]);
	});
});

describe("storageSetJSON", () => {
	test("stores a JSON-serializable object", () => {
		storageSetJSON("data", { x: 42 });
		expect(JSON.parse(localStorage.getItem("data") ?? "")).toEqual({ x: 42 });
	});

	test("stores an array", () => {
		storageSetJSON("list", [1, 2]);
		expect(JSON.parse(localStorage.getItem("list") ?? "")).toEqual([1, 2]);
	});
});

describe("storageSetOrRemove", () => {
	test("sets value when truthy", () => {
		storageSetOrRemove("key", "hello");
		expect(localStorage.getItem("key")).toBe("hello");
	});

	test("removes key when null", () => {
		localStorage.setItem("key", "old");
		storageSetOrRemove("key", null);
		expect(localStorage.getItem("key")).toBeNull();
	});

	test("removes key when undefined", () => {
		localStorage.setItem("key", "old");
		storageSetOrRemove("key", undefined);
		expect(localStorage.getItem("key")).toBeNull();
	});

	test("removes key when empty string", () => {
		localStorage.setItem("key", "old");
		storageSetOrRemove("key", "");
		expect(localStorage.getItem("key")).toBeNull();
	});
});
