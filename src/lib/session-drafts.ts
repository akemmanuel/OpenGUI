import { STORAGE_KEYS } from "@/lib/constants";
import { persistOrRemoveJSON, storageParsed } from "@/lib/safe-storage";

export type SessionDraftMap = Record<string, string>;

export function getSessionDraftKey(input: {
	sessionId?: string | null;
	directory?: string | null;
	workspaceId?: string | null;
}): string | null {
	if (input.sessionId) return `session:${input.sessionId}`;
	if (input.directory) {
		return `draft:${input.workspaceId ?? ""}:${input.directory}`;
	}
	return null;
}

export function pruneSessionDrafts(drafts: SessionDraftMap): SessionDraftMap {
	const pruned: SessionDraftMap = {};
	for (const [key, value] of Object.entries(drafts)) {
		const trimmed = value.trim();
		if (trimmed.length > 0) {
			pruned[key] = value;
		}
	}
	return pruned;
}

export function getSessionDrafts(): SessionDraftMap {
	return pruneSessionDrafts(
		storageParsed<SessionDraftMap>(STORAGE_KEYS.SESSION_DRAFTS) ?? {},
	);
}

export function persistSessionDrafts(drafts: SessionDraftMap): void {
	const pruned = pruneSessionDrafts(drafts);
	persistOrRemoveJSON(
		STORAGE_KEYS.SESSION_DRAFTS,
		pruned,
		Object.keys(pruned).length === 0,
	);
}
