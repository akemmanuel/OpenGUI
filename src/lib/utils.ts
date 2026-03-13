import type { Agent, Model, Provider } from "@opencode-ai/sdk/v2/client";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Abbreviate an absolute path by replacing the home directory prefix with ~. */
export function abbreviatePath(path: string, homeDir: string): string {
	if (homeDir && path.startsWith(homeDir)) {
		return `~${path.slice(homeDir.length)}`;
	}
	return path;
}

/**
 * Compare two semver version strings (e.g. "0.1.11" vs "0.2.0").
 * Returns  1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const na = pa[i] ?? 0;
		const nb = pb[i] ?? 0;
		if (na > nb) return 1;
		if (na < nb) return -1;
	}
	return 0;
}

/** Find a model by provider ID and model ID in a providers list. */
export function findModel(
	providers: Provider[],
	providerID: string,
	modelID: string,
): Model | undefined {
	const prov = providers.find((p) => p.id === providerID);
	if (!prov) return undefined;
	return prov.models[modelID];
}

// ---------------------------------------------------------------------------
// Shared helpers extracted from duplicated patterns across the codebase
// ---------------------------------------------------------------------------

/** Default agent name used throughout the application. */
export const DEFAULT_AGENT_NAME = "build";

/** Check whether an agent is selectable (primary/all mode and not hidden). */
export function isSelectableAgent(agent: Agent): boolean {
	return (agent.mode === "primary" || agent.mode === "all") && !agent.hidden;
}

/**
 * Filter and sort agents to get primary (selectable) agents.
 * The default agent ("build") is sorted first; the rest keeps original order.
 */
export function getPrimaryAgents(agents: Agent[]): Agent[] {
	return agents.filter(isSelectableAgent).sort((a, b) => {
		const aIsDefault = a.name === DEFAULT_AGENT_NAME ? 1 : 0;
		const bIsDefault = b.name === DEFAULT_AGENT_NAME ? 1 : 0;
		return bIsDefault - aIsDefault;
	});
}

/** Extract the trailing directory name from an absolute path (cross-platform). */
export function getProjectName(directory: string, fallback = "repo"): string {
	const parts = directory.replace(/[/\\]+$/, "").split(/[/\\]/);
	return parts[parts.length - 1] || fallback;
}

/** Safely extract an error message from an unknown catch value. */
export function getErrorMessage(
	err: unknown,
	fallback = "Unexpected error",
): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return fallback;
}

/** Open a URL in the system browser via the Electron bridge, with fallback. */
export function openExternalLink(url: string): void {
	if (window.electronAPI?.openExternal) {
		window.electronAPI.openExternal(url);
	} else {
		window.open(url, "_blank", "noopener,noreferrer");
	}
}

/**
 * Format an ISO date string or timestamp as a relative "X ago" label.
 * Accepts an ISO string or epoch-ms number.
 */
export function formatTimeAgo(date: string | number): string {
	const ms = typeof date === "string" ? Date.parse(date) : date;
	if (Number.isNaN(ms)) return "";
	const seconds = Math.floor((Date.now() - ms) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	return `${months}mo ago`;
}

/**
 * Compute the total token count from a token snapshot.
 * Prefers the authoritative `total` field; falls back to summing components.
 */
export function computeTokenTotal(tokens: {
	total?: number;
	input?: number;
	output?: number;
	reasoning?: number;
	cache?: { read?: number; write?: number };
}): number {
	if (typeof tokens.total === "number" && tokens.total > 0) return tokens.total;
	return (
		(tokens.input ?? 0) +
		(tokens.output ?? 0) +
		(tokens.reasoning ?? 0) +
		(tokens.cache?.read ?? 0) +
		(tokens.cache?.write ?? 0)
	);
}
