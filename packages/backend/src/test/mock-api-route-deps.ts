import type { HarnessId } from "@opengui/protocol";
import type { DirectoryScopeRef } from "@opengui/runtime";
import type { ApiRouteDeps } from "../http/types.ts";
import type { BackendServiceContext, SessionRecord } from "../../../../server/services/index.ts";

export function createMockApiRouteDeps(
  overrides: Partial<ApiRouteDeps> & {
    services?: BackendServiceContext;
    canonicalDirectory?: string;
  } = {},
): ApiRouteDeps {
  const canonical = overrides.canonicalDirectory ?? "/tmp/opengui-test-repo";
  const services =
    overrides.services ??
    ({
      harnesses: {
        getManagedHarnessIds: () => ["pi", "opencode"] as HarnessId[],
        listDirectorySessions: async () => [],
      },
    } as unknown as BackendServiceContext);

  const baseSession: SessionRecord = {
    id: "pi:session-1",
    rawId: "session-1",
    directory: canonical,
    harnessId: "pi",
    title: "Test",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const scopeRef: DirectoryScopeRef = {
    id: "scope-test",
    path: canonical,
    canonicalPath: canonical,
    displayName: "Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  return {
    getServices: overrides.getServices ?? (async () => services),
    resolveSafeDirectory:
      overrides.resolveSafeDirectory ?? (async (inputPath) => inputPath?.trim() || canonical),
    resolveHarnessDirectoryForSessions:
      overrides.resolveHarnessDirectoryForSessions ??
      (async ({ directory }) => ({
        directory,
        canonicalPath: canonical,
      })),
    parseSessionScopeFromUrl:
      overrides.parseSessionScopeFromUrl ??
      ((url) => ({
        directory: url.searchParams.get("directory") ?? undefined,
        harnessId: (url.searchParams.get("harnessId") as HarnessId | null) ?? undefined,
      })),
    getSessionDirectoryScopeOrThrow:
      overrides.getSessionDirectoryScopeOrThrow ?? (async () => scopeRef),
    sessionQueueScope:
      overrides.sessionQueueScope ??
      (async () => ({ directory: canonical, harnessId: "pi" as HarnessId })),
    getSessionForRead: overrides.getSessionForRead ?? (async () => baseSession),
    getSessionOrThrow: overrides.getSessionOrThrow ?? (async () => baseSession),
    resolvePermissionSessionScope:
      overrides.resolvePermissionSessionScope ?? (async () => ({ session: baseSession, scopeRef })),
  };
}
