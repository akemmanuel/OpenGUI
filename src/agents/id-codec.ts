import type { HarnessId } from "./index.ts";
import { composeFrontendSessionId, rawSessionIdForHarness } from "../lib/session-identity.ts";

export type HarnessIdCodec = {
  compose(rawId: string): string;
  decompose(sessionId: string): string;
  matches(sessionId: string | null | undefined): boolean;
};

/** @deprecated Use HarnessIdCodec */
export type BackendIdCodec = HarnessIdCodec;

export function createHarnessIdCodec(prefix: HarnessId): HarnessIdCodec {
  const marker = `${prefix}:`;
  return {
    compose: (rawId: string) => composeFrontendSessionId(prefix, rawId),
    decompose: (sessionId: string) => rawSessionIdForHarness(sessionId, prefix),
    matches: (sessionId: string | null | undefined) => Boolean(sessionId?.startsWith(marker)),
  };
}

/** @deprecated Use createHarnessIdCodec */
export const createBackendIdCodec = createHarnessIdCodec;
