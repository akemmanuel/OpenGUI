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
		void window.electronAPI.openExternal(url);
	} else {
		window.open(url, "_blank", "noopener,noreferrer");
	}
}

export function looksLikeTerminalOutput(content: string): boolean {
	return (
		content.includes("\u001b[") ||
		content.includes("\u009b") ||
		content.includes("\r") ||
		content.includes("\b") ||
		/[│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬]/.test(content)
	);
}

function writeChar(line: string[], cursor: number, char: string): number {
	while (line.length < cursor) line.push(" ");
	line[cursor] = char;
	return cursor + 1;
}

export function normalizeTerminalOutput(content: string): string {
	const lines: string[] = [];
	let currentLine: string[] = [];
	let cursor = 0;

	const commitLine = () => {
		lines.push(currentLine.join(""));
		currentLine = [];
		cursor = 0;
	};

	for (let i = 0; i < content.length; i++) {
		const char = content[i] ?? "";

		if (char === "\u001b" || char === "\u009b") {
			let finalChar = "";
			let params = "";

			if (char === "\u001b" && content[i + 1] === "]") {
				i += 2;
				while (i < content.length) {
					if (content[i] === "\u0007") break;
					if (content[i] === "\u001b" && content[i + 1] === "\\") {
						i += 1;
						break;
					}
					i += 1;
				}
				continue;
			}

			if (char === "\u001b" && content[i + 1] === "[") {
				i += 2;
			} else if (char === "\u009b") {
				i += 1;
			} else {
				continue;
			}

			for (; i < content.length; i++) {
				const code = content.charCodeAt(i);
				if (code >= 0x40 && code <= 0x7e) {
					finalChar = content[i] ?? "";
					break;
				}
				params += content[i] ?? "";
			}

			const [firstParam = ""] = params.split(";");
			const amount = Number.parseInt(firstParam, 10);
			const count = Number.isFinite(amount) ? amount : 1;

			switch (finalChar) {
				case "C":
					cursor += count;
					break;
				case "D":
					cursor = Math.max(0, cursor - count);
					break;
				case "G":
					cursor = Math.max(0, count - 1);
					break;
				case "K": {
					const mode = Number.isFinite(amount) ? amount : 0;
					if (mode === 0) {
						currentLine.length = cursor;
					} else if (mode === 1) {
						for (let j = 0; j <= cursor && j < currentLine.length; j++) {
							currentLine[j] = " ";
						}
					} else if (mode === 2) {
						currentLine = [];
						cursor = 0;
					}
					break;
				}
				case "J":
					if (amount === 2 || amount === 3) {
						lines.length = 0;
						currentLine = [];
						cursor = 0;
					}
					break;
				default:
					break;
			}

			continue;
		}

		if (char === "\r") {
			cursor = 0;
			continue;
		}

		if (char === "\n") {
			commitLine();
			continue;
		}

		if (char === "\b") {
			cursor = Math.max(0, cursor - 1);
			continue;
		}

		if (char === "\t") {
			const spaces = 4 - (cursor % 4 || 0);
			for (let j = 0; j < spaces; j++) {
				cursor = writeChar(currentLine, cursor, " ");
			}
			continue;
		}

		cursor = writeChar(currentLine, cursor, char);
	}

	if (currentLine.length > 0 || content.endsWith("\n")) {
		lines.push(currentLine.join(""));
	}

	return lines.join("\n");
}

/** Build a compare URL for creating a pull request from a remote URL and branch. */
export function buildPRUrl(
	remoteUrl: string,
	branch: string,
	baseBranch = "main",
): string | null {
	let base: string | null = null;
	const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
	if (sshMatch) {
		base = `https://${sshMatch[1]}/${sshMatch[2]}`;
	}
	const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
	if (httpsMatch) {
		base = `https://${httpsMatch[1]}/${httpsMatch[2]}`;
	}
	if (!base) return null;
	return `${base}/compare/${baseBranch}...${branch}`;
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
