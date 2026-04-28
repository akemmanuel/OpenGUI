import { describe, expect, test } from "bun:test";
import {
	prependProjectIfMissing,
	sortSidebarSessionsNewestFirst,
} from "../sidebar-order";

describe("prependProjectIfMissing", () => {
	test("puts new project at top", () => {
		expect(prependProjectIfMissing(["/repo-a", "/repo-b"], "/repo-c")).toEqual([
			"/repo-c",
			"/repo-a",
			"/repo-b",
		]);
	});

	test("keeps existing project order", () => {
		expect(prependProjectIfMissing(["/repo-a", "/repo-b"], "/repo-b")).toEqual([
			"/repo-a",
			"/repo-b",
		]);
	});
});

describe("sortSidebarSessionsNewestFirst", () => {
	test("sorts newest session first", () => {
		const sessions = [
			{ id: "a", time: { created: 10, updated: 20 } },
			{ id: "b", time: { created: 30, updated: 30 } },
			{ id: "c", time: { created: 25 } },
		];

		expect(sortSidebarSessionsNewestFirst(sessions).map((session) => session.id)).toEqual([
			"b",
			"c",
			"a",
		]);
	});
});
