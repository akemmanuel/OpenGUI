import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { STORAGE_KEYS } from "../constants";
import {
	getSessionDraftKey,
	getSessionDrafts,
	persistSessionDrafts,
	pruneSessionDrafts,
} from "../session-drafts";
import { polyfillLocalStorage } from "./setup";

beforeAll(() => {
	polyfillLocalStorage();
});

afterEach(() => {
	localStorage.clear();
});

describe("getSessionDraftKey", () => {
	test("prefers session ids when present", () => {
		expect(
			getSessionDraftKey({ sessionId: "abc", directory: "/tmp/project" }),
		).toBe("session:abc");
	});

	test("builds keys for draft directories", () => {
		expect(getSessionDraftKey({ directory: "/tmp/project" })).toBe(
			"draft::/tmp/project",
		);
	});

	test("returns null when no target exists", () => {
		expect(getSessionDraftKey({})).toBeNull();
	});
});

describe("pruneSessionDrafts", () => {
	test("drops blank drafts and keeps meaningful text", () => {
		expect(
			pruneSessionDrafts({
				"session:a": "hello",
				"session:b": "   ",
				"draft:/tmp": "\n",
			}),
		).toEqual({ "session:a": "hello" });
	});
});

describe("session draft persistence", () => {
	test("reads persisted drafts and prunes blanks", () => {
		localStorage.setItem(
			STORAGE_KEYS.SESSION_DRAFTS,
			JSON.stringify({
				"session:a": "kept",
				"session:b": "",
			}),
		);

		expect(getSessionDrafts()).toEqual({ "session:a": "kept" });
	});

	test("persists only non-empty drafts", () => {
		persistSessionDrafts({
			"session:a": "kept",
			"session:b": "   ",
		});

		expect(
			JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION_DRAFTS) ?? ""),
		).toEqual({
			"session:a": "kept",
		});
	});

	test("removes storage when all drafts are blank", () => {
		persistSessionDrafts({ "session:a": "   " });

		expect(localStorage.getItem(STORAGE_KEYS.SESSION_DRAFTS)).toBeNull();
	});
});
