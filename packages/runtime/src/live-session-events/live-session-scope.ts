import type { HarnessId } from "../../../../src/agents/index.ts";
import {
  composeFrontendSessionId,
  parseFrontendSessionId,
} from "../../../../src/lib/session-identity.ts";

/** Canonical `LiveSessionScope.sessionId` form: `harness:raw` (matches SDK `SessionHandle.id`). */
export function toLiveSessionScopeSessionId(
  harnessId: HarnessId,
  sessionIdFromWire: string,
): string {
  const parsed = parseFrontendSessionId(sessionIdFromWire);
  if (parsed) {
    if (parsed.harnessId !== harnessId) {
      return composeFrontendSessionId(harnessId, parsed.rawId);
    }
    return composeFrontendSessionId(parsed.harnessId, parsed.rawId);
  }
  return composeFrontendSessionId(harnessId, sessionIdFromWire);
}

/** Raw harness session id for status maps and bridge scope (no `harness:` prefix). */
export function rawSessionIdFromWire(harnessId: HarnessId, sessionIdFromWire: string): string {
  const parsed = parseFrontendSessionId(sessionIdFromWire);
  if (parsed) {
    if (parsed.harnessId !== harnessId) return parsed.rawId;
    return parsed.rawId;
  }
  return sessionIdFromWire;
}
