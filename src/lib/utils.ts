import type { Model, Provider } from "@opencode-ai/sdk/v2/client";
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
