import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { STORAGE_KEYS } from "../constants";
import {
	getSidebarCollapsedProjects,
	isSidebarProjectCollapsed,
	persistSidebarCollapsedProjects,
	pruneSidebarCollapsedProjects,
	toggleSidebarProjectCollapsed,
} from "../sidebar-collapsed";
import { polyfillLocalStorage } from "./setup";

beforeAll(() => {
	polyfillLocalStorage();
});

afterEach(() => {
	localStorage.clear();
});

describe("toggleSidebarProjectCollapsed", () => {
	test("stores normalized collapsed project keys", () => {
		const collapsed = toggleSidebarProjectCollapsed({}, "/repo/");
		expect(collapsed).toEqual({ "/repo": true });
	});

	test("removes key when toggled twice", () => {
		const collapsed = toggleSidebarProjectCollapsed({ "/repo": true }, "/repo");
		expect(collapsed).toEqual({});
	});
});

describe("pruneSidebarCollapsedProjects", () => {
	test("drops non-collapsed and stale projects", () => {
		expect(
			pruneSidebarCollapsedProjects(
				{ "/repo-a": true, "/repo-b": false, "/repo-c": true },
				["/repo-a/", "/repo-b"],
			),
		).toEqual({ "/repo-a": true });
	});
});

describe("storage helpers", () => {
	test("round-trips collapsed state", () => {
		persistSidebarCollapsedProjects({ "/repo": true });
		expect(getSidebarCollapsedProjects()).toEqual({ "/repo": true });
		expect(isSidebarProjectCollapsed(getSidebarCollapsedProjects(), "/repo/")).toBe(
			true,
		);
	});

	test("normalizes legacy stored keys", () => {
		localStorage.setItem(
			STORAGE_KEYS.SIDEBAR_PROJECT_COLLAPSED,
			JSON.stringify({ "/repo/": true, "/repo-b": false }),
		);
		expect(getSidebarCollapsedProjects()).toEqual({ "/repo": true });
	});
});
