import { describe, expect, test } from "bun:test";
import { canNavigateHistoryAtCursor } from "../prompt-history";

describe("canNavigateHistoryAtCursor", () => {
	test("blocks up while editing non-empty text, even at position 0", () => {
		expect(canNavigateHistoryAtCursor("up", "hello", 0, false)).toBe(false);
	});

	test("blocks down while editing non-empty text, even at end", () => {
		expect(canNavigateHistoryAtCursor("down", "hello", 5, false)).toBe(
			false,
		);
	});

	test("up: allows when draft is empty at position 0", () => {
		expect(canNavigateHistoryAtCursor("up", "", 0, false)).toBe(true);
	});

	test("down: blocks when draft is empty", () => {
		expect(canNavigateHistoryAtCursor("down", "", 0, false)).toBe(false);
	});

	test("inHistory: allows navigation from start", () => {
		expect(canNavigateHistoryAtCursor("up", "hello", 0, true)).toBe(true);
		expect(canNavigateHistoryAtCursor("down", "hello", 0, true)).toBe(true);
	});

	test("inHistory: allows navigation from end", () => {
		expect(canNavigateHistoryAtCursor("up", "hello", 5, true)).toBe(true);
		expect(canNavigateHistoryAtCursor("down", "hello", 5, true)).toBe(true);
	});

	test("inHistory: blocks from middle", () => {
		expect(canNavigateHistoryAtCursor("up", "hello", 2, true)).toBe(false);
	});

	test("clamps negative cursor position", () => {
		expect(canNavigateHistoryAtCursor("up", "", -5, false)).toBe(true);
	});

	test("clamps cursor beyond text length", () => {
		expect(canNavigateHistoryAtCursor("down", "", 100, false)).toBe(false);
	});
});
