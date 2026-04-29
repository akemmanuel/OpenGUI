import { STORAGE_KEYS } from "@/lib/constants";
import { persistOrRemoveJSON, storageParsed } from "@/lib/safe-storage";
import { normalizeProjectPath } from "@/lib/utils";

export type SidebarCollapsedProjects = Record<string, true>;

export function pruneSidebarCollapsedProjects(
	collapsed: Record<string, boolean>,
	projectDirectories: readonly string[],
): SidebarCollapsedProjects {
	const validDirectories = new Set(
		projectDirectories
			.map((directory) => normalizeProjectPath(directory))
			.filter(Boolean),
	);
	const next: SidebarCollapsedProjects = {};
	for (const [directory, isCollapsed] of Object.entries(collapsed)) {
		const normalizedDirectory = normalizeProjectPath(directory);
		if (!normalizedDirectory || !isCollapsed) continue;
		if (!validDirectories.has(normalizedDirectory)) continue;
		next[normalizedDirectory] = true;
	}
	return next;
}

export function getSidebarCollapsedProjects(): SidebarCollapsedProjects {
	const collapsed =
		storageParsed<Record<string, boolean>>(STORAGE_KEYS.SIDEBAR_PROJECT_COLLAPSED) ??
		{};
	return pruneSidebarCollapsedProjects(collapsed, Object.keys(collapsed));
}

export function persistSidebarCollapsedProjects(
	collapsed: SidebarCollapsedProjects,
): void {
	persistOrRemoveJSON(
		STORAGE_KEYS.SIDEBAR_PROJECT_COLLAPSED,
		collapsed,
		Object.keys(collapsed).length === 0,
	);
}

export function isSidebarProjectCollapsed(
	collapsed: SidebarCollapsedProjects,
	directory: string,
): boolean {
	return !!collapsed[normalizeProjectPath(directory)];
}

export function toggleSidebarProjectCollapsed(
	collapsed: SidebarCollapsedProjects,
	directory: string,
): SidebarCollapsedProjects {
	const normalizedDirectory = normalizeProjectPath(directory);
	if (!normalizedDirectory) return collapsed;
	const next = { ...collapsed };
	if (next[normalizedDirectory]) {
		delete next[normalizedDirectory];
	} else {
		next[normalizedDirectory] = true;
	}
	return next;
}
