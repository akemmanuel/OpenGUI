import { isAbsolute, resolve } from "node:path";
import type { DurableActor } from "./harness.ts";

export type ExecutionPathAccess = "read" | "write";

export interface ExecutionPathDecision {
  allowed: boolean;
  canonicalPath?: string;
  reason?: string;
}

/** Current Host-owned capabilities for one durable actor. */
export interface ExecutionPolicy {
  restricted: boolean;
  revision: number;
  shellAllowed: boolean;
  /** Canonical grant roots when restricted; omitted by legacy embeddings. */
  grants?: ReadonlyArray<{ root: string; access: ExecutionPathAccess }>;
  authorizePath(
    path: string,
    access: ExecutionPathAccess,
    options?: { allowMissingLeaf?: boolean },
  ): Promise<ExecutionPathDecision>;
}

/**
 * Resolves current capabilities. `actor` is undefined for legacy actorless
 * records; an embedding Host with policy enabled must decide how those behave.
 */
export type ExecutionPolicyResolver = (actor: DurableActor | undefined) => Promise<ExecutionPolicy>;

export function unrestrictedExecutionPolicy(projectDirectory: string): ExecutionPolicy {
  return {
    restricted: false,
    revision: 0,
    shellAllowed: true,
    async authorizePath(path) {
      return {
        allowed: true,
        canonicalPath: isAbsolute(path) ? resolve(path) : resolve(projectDirectory, path),
      };
    },
  };
}
