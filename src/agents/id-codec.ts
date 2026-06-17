import type { HarnessId } from "./index.ts";
import { composeFrontendSessionId, rawSessionIdForHarness } from "../lib/session-identity.ts";

export type HarnessIdCodec = {
  compose(rawId: string): string;
  decompose(sessionId: string): string;
  matches(sessionId: string | null | undefined): boolean;
};

export function createHarnessIdCodec(prefix: HarnessId): HarnessIdCodec {
  const marker = `${prefix}:`;
  return {
    compose: (rawId: string) => composeFrontendSessionId(prefix, rawId),
    decompose: (sessionId: string) => rawSessionIdForHarness(sessionId, prefix),
    matches: (sessionId: string | null | undefined) => Boolean(sessionId?.startsWith(marker)),
  };
}
