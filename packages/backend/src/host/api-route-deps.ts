import { realpath } from "node:fs/promises";
import type { HarnessId } from "@opengui/protocol";
import {
  queueScopeForSession,
  resolveCanonicalDirectoryInput,
  resolveSessionDirectoryScope,
  resolveSessionRecordForMutation,
  resolveSessionRecordForRead,
  toOptionalString,
  type BackendServiceContext,
  type SessionRecord,
} from "../../../../server/services/index.ts";
import type { DirectoryScopeRef } from "@opengui/runtime";
import { isManagedHarnessId } from "@opengui/runtime";
import type { ApiRouteDeps } from "../http/types.ts";

export function createApiRouteDeps(input: {
  getServices: () => Promise<BackendServiceContext>;
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>;
}): ApiRouteDeps {
  const { getServices, resolveSafeDirectory } = input;

  async function getSessionDirectoryScopeOrThrow(
    _services: BackendServiceContext,
    session: SessionRecord,
  ): Promise<DirectoryScopeRef> {
    return await resolveSessionDirectoryScope({
      session,
      resolveSafeDirectory,
    });
  }

  async function sessionQueueScope(session: SessionRecord) {
    const canonicalDirectory = await resolveSessionDirectoryScope({
      session,
      resolveSafeDirectory,
    }).then((p) => p.canonicalPath);
    return queueScopeForSession(session, canonicalDirectory);
  }

  async function getSessionForRead(
    services: BackendServiceContext,
    sessionId: string,
    scope: { directory?: string; harnessId?: HarnessId } = {},
  ): Promise<SessionRecord> {
    return await resolveSessionRecordForRead({
      services,
      sessionId,
      scope,
      resolveSafeDirectory,
    });
  }

  async function getSessionOrThrow(
    services: BackendServiceContext,
    sessionId: string,
    scope: { directory?: string; harnessId?: HarnessId } = {},
  ): Promise<SessionRecord> {
    return await resolveSessionRecordForMutation({
      services,
      sessionId,
      scope,
      resolveSafeDirectory,
    });
  }

  async function resolvePermissionSessionScope(
    services: BackendServiceContext,
    body: Record<string, unknown>,
  ): Promise<{ session: SessionRecord; scopeRef: DirectoryScopeRef }> {
    const sessionId = toOptionalString(body.sessionId, "sessionId");
    if (!sessionId) throw new Error("sessionId and response are required");
    const harnessId =
      (toOptionalString(body.harnessId, "harnessId") as HarnessId | undefined) ?? undefined;
    const directory =
      toOptionalString(body.directory, "directory") ??
      toOptionalString(body.projectId, "projectId") ??
      undefined;

    const session = await getSessionOrThrow(services, sessionId, {
      directory,
      harnessId,
    });
    return {
      session,
      scopeRef: await getSessionDirectoryScopeOrThrow(services, session),
    };
  }

  async function resolveHarnessDirectoryForSessions(inputScope: {
    directory: string;
  }): Promise<{ directory: string; canonicalPath: string }> {
    return await resolveCanonicalDirectoryInput(
      inputScope.directory,
      resolveSafeDirectory,
      realpath,
    );
  }

  function parseSessionScopeFromUrl(url: URL): {
    directory?: string;
    harnessId?: HarnessId;
  } {
    const directory =
      url.searchParams.get("directory")?.trim() ||
      url.searchParams.get("projectId")?.trim() ||
      undefined;
    const harnessIdRaw = url.searchParams.get("harnessId");
    const harnessId = harnessIdRaw && isManagedHarnessId(harnessIdRaw) ? harnessIdRaw : undefined;
    return { directory, harnessId };
  }

  return {
    getServices,
    resolveSafeDirectory,
    resolveHarnessDirectoryForSessions,
    parseSessionScopeFromUrl,
    getSessionDirectoryScopeOrThrow,
    sessionQueueScope,
    getSessionForRead,
    getSessionOrThrow,
    resolvePermissionSessionScope,
  };
}
