import type { Agent, Model, Provider } from "@/protocol/agent-types";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
function isSelectableAgent(agent: Agent): boolean {
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

/** Safely extract an error message from an unknown catch value. */
export function getErrorMessage(err: unknown, fallback = "Unexpected error"): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

/**
 * Create a UUID in browser-like runtimes where crypto.randomUUID may be absent
 * (for example file://, insecure HTTP, older WebViews), while still preferring
 * the native implementation when available.
 */
export function createUuid(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
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

/** Prune keys not in `validKeys` from a Record. Returns prev if unchanged. */
export function pruneRecord<T>(prev: Record<string, T>, validKeys: Set<string>): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const key of Object.keys(prev)) {
    if (validKeys.has(key)) {
      const val = prev[key];
      if (val !== undefined) next[key] = val;
    } else {
      changed = true;
    }
  }
  return changed ? next : prev;
}
