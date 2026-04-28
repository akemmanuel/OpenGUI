export interface SidebarSortableSessionLike {
	id: string;
	time: {
		created?: number;
		updated?: number;
	};
}

export function getSidebarSessionSortTime(
	session: SidebarSortableSessionLike,
): number {
	return session.time.updated ?? session.time.created ?? 0;
}

export function sortSidebarSessionsNewestFirst<
	TSession extends SidebarSortableSessionLike,
>(sessions: TSession[]): TSession[] {
	return [...sessions].sort((a, b) => {
		const byUpdated =
			getSidebarSessionSortTime(b) - getSidebarSessionSortTime(a);
		if (byUpdated !== 0) return byUpdated;
		return b.id.localeCompare(a.id);
	});
}

export function prependProjectIfMissing(
	projects: string[],
	directory: string,
): string[] {
	return projects.includes(directory) ? projects : [directory, ...projects];
}
