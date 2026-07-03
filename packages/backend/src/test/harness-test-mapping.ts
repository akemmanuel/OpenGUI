import type { BackendServiceContext } from "../../../../server/services/index.ts";

/** Narrow unknown harness/IPC-shaped values to string (optional fallback when absent or non-string). */
export function asHarnessString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Coerce a partial test double to {@link BackendServiceContext} without widening mocks to `any`. */
export function asBackendServiceContext(partial: unknown): BackendServiceContext {
  return partial as unknown as BackendServiceContext;
}
