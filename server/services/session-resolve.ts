import type { HarnessId } from "@opengui/protocol";
import {
  composeFrontendSessionId,
  decodeCanonicalDirectorySessionId,
  resolveWireSessionIdentity,
} from "../../src/lib/session-identity.ts";
import type { BackendServiceContext } from "./index.ts";
import { listDirectorySessionsFromHarness } from "./session-harness-list.ts";
import type { SessionRecord } from "./session-types.ts";

function resolveLookup(input: {
  sessionId: string;
  scope: { directory?: string; harnessId?: HarnessId };
}) {
  const identity = resolveWireSessionIdentity(input.sessionId, input.scope.harnessId);
  const lookupId = identity?.wireId ?? input.sessionId;
  const directoryHint =
    input.scope.directory ?? decodeCanonicalDirectorySessionId(input.sessionId)?.directory;
  const harnessId = input.scope.harnessId ?? identity?.harnessId;
  return { identity, lookupId, directoryHint, harnessId };
}

/** Product read APIs (session GET, message pages): Harness membership only (ADR 0006). */
export async function resolveSessionRecordForRead(input: {
  services: BackendServiceContext;
  sessionId: string;
  scope: { directory?: string; harnessId?: HarnessId };
  resolveSafeDirectory: (path: string) => Promise<string>;
}): Promise<SessionRecord> {
  const { lookupId, directoryHint, harnessId } = resolveLookup(input);
  if (!harnessId) throw new Error("Session not found");
  if (!directoryHint) throw new Error("directory is required");

  const canonicalPath = await input.resolveSafeDirectory(directoryHint);
  const listed = await listDirectorySessionsFromHarness(
    input.services,
    { directory: canonicalPath, canonicalPath },
    harnessId,
  );
  const fromHarness = listed.find((s) => s.id === lookupId);
  if (!fromHarness) throw new Error("Session not found");
  return fromHarness;
}

/**
 * Resolve a session for Queue dispatch and control mutations: dispatch index cache, then harness relist + `ensureSession`.
 * Never invents identity from wire id alone (ADR 0006).
 */
export async function resolveSessionRecordForMutation(input: {
  services: BackendServiceContext;
  sessionId: string;
  scope: { directory?: string; harnessId?: HarnessId };
  resolveSafeDirectory: (path: string) => Promise<string>;
}): Promise<SessionRecord> {
  const { lookupId, directoryHint, harnessId } = resolveLookup(input);

  const cached = await input.services.sessions.getSession(lookupId, input.scope);
  if (cached) return cached;

  if (!harnessId) throw new Error("Session not found");

  if (directoryHint) {
    const canonicalPath = await input.resolveSafeDirectory(directoryHint);
    try {
      const listed = await listDirectorySessionsFromHarness(
        input.services,
        { directory: canonicalPath, canonicalPath },
        harnessId,
      );
      const fromHarness = listed.find((s) => s.id === lookupId);
      if (fromHarness) {
        await input.services.sessions.ensureSession({
          id: fromHarness.id,
          rawId: fromHarness.rawId,
          directory: fromHarness.directory,
          harnessId: fromHarness.harnessId,
          title: fromHarness.title,
          status: fromHarness.status,
          metadata: fromHarness.metadata,
          createdAt: fromHarness.createdAt,
          updatedAt: fromHarness.updatedAt,
        });
        return fromHarness;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message || "Harness session list failed");
    }
  }

  throw new Error("Session not found");
}

export function wireSessionIdFromRecord(session: SessionRecord): string {
  return composeFrontendSessionId(session.harnessId, session.rawId);
}
