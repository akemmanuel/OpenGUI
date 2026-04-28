import type { SelectedModel } from "@/types/electron";
import { STORAGE_KEYS } from "@/lib/constants";
import { persistOrRemoveJSON, storageParsed } from "@/lib/safe-storage";

export type SessionDraftMap = Record<string, string>;
export type SessionDraftImagesMap = Record<string, string[]>;
export type QueueMode = "queue" | "interrupt" | "after-part";
export type QueuedPrompt = {
	id: string;
	text: string;
	images?: string[];
	createdAt: number;
	model?: SelectedModel;
	agent?: string;
	variant?: string;
	mode: QueueMode;
};
export type QueuedPromptsMap = Record<string, QueuedPrompt[]>;

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

export function pruneSessionDraftImages(
	images: SessionDraftImagesMap,
): SessionDraftImagesMap {
	const pruned: SessionDraftImagesMap = {};
	for (const [key, value] of Object.entries(images)) {
		const next = value.filter(
			(image) => typeof image === "string" && image.trim().length > 0,
		);
		if (next.length > 0) {
			pruned[key] = next;
		}
	}
	return pruned;
}

export function getSessionDraftImages(): SessionDraftImagesMap {
	return pruneSessionDraftImages(
		storageParsed<SessionDraftImagesMap>(STORAGE_KEYS.SESSION_DRAFT_IMAGES) ??
			{},
	);
}

export function persistSessionDraftImages(
	images: SessionDraftImagesMap,
): void {
	const pruned = pruneSessionDraftImages(images);
	persistOrRemoveJSON(
		STORAGE_KEYS.SESSION_DRAFT_IMAGES,
		pruned,
		Object.keys(pruned).length === 0,
	);
}

export function getQueuedPrompts(): QueuedPromptsMap {
	return storageParsed<QueuedPromptsMap>(STORAGE_KEYS.QUEUED_PROMPTS) ?? {};
}

export function persistQueuedPrompts(queue: QueuedPromptsMap): void {
	const hasItems = Object.values(queue).some((arr) => arr.length > 0);
	persistOrRemoveJSON(STORAGE_KEYS.QUEUED_PROMPTS, queue, !hasItems);
}
