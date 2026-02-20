import { describe, expect, test } from "bun:test";
import { canNavigateHistoryAtCursor } from "../prompt-history";

describe("canNavigateHistoryAtCursor", () => {
	test("up: allows when cursor is at position 0", () => {
		expect(canNavigateHistoryAtCursor("up", "hello", 0, false)).toBe(true);
	});

	test("up: blocks when cursor is not at position 0", () => {
		expect(canNavigateHistoryAtCursor("up", "hello", 3, false)).toBe(false);
	});

	test("down: allows when cursor is at end of text", () => {
		expect(canNavigateHistoryAtCursor("down", "hello", 5, false)).toBe(true);
	});

	test("down: blocks when cursor is not at end", () => {
		expect(canNavigateHistoryAtCursor("down", "hello", 2, false)).toBe(false);
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

	test("handles empty text", () => {
		expect(canNavigateHistoryAtCursor("up", "", 0, false)).toBe(true);
		expect(canNavigateHistoryAtCursor("down", "", 0, false)).toBe(true);
	});

	test("clamps negative cursor position", () => {
		expect(canNavigateHistoryAtCursor("up", "hello", -5, false)).toBe(true);
	});

	test("clamps cursor beyond text length", () => {
		expect(canNavigateHistoryAtCursor("down", "hello", 100, false)).toBe(true);
	});
});
