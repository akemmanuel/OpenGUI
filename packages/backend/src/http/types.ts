import type { HarnessId } from "@opengui/protocol";
import type { BackendServiceContext, SessionRecord } from "../../../../server/services/index.ts";

export type ApiRouteDeps = {
  getServices: () => Promise<BackendServiceContext>;
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>;
  resolveHarnessDirectoryForSessions: (input: {
    directory: string;
  }) => Promise<{ directory: string; canonicalPath: string }>;
  parseSessionScopeFromUrl: (url: URL) => { directory?: string; harnessId?: HarnessId };
  getSessionDirectoryScopeOrThrow: (
    services: BackendServiceContext,
    session: SessionRecord,
  ) => Promise<import("@opengui/runtime").DirectoryScopeRef>;
  sessionQueueScope: (
    session: SessionRecord,
  ) => Promise<{ directory: string; harnessId: HarnessId }>;
  getSessionForRead: (
    services: BackendServiceContext,
    sessionId: string,
    scope?: { directory?: string; harnessId?: HarnessId },
  ) => Promise<SessionRecord>;
  getSessionOrThrow: (
    services: BackendServiceContext,
    sessionId: string,
    scope?: { directory?: string; harnessId?: HarnessId },
  ) => Promise<SessionRecord>;
  resolvePermissionSessionScope: (
    services: BackendServiceContext,
    body: Record<string, unknown>,
  ) => Promise<{ session: SessionRecord; scopeRef: import("@opengui/runtime").DirectoryScopeRef }>;
};

export type ForwardedHandler = (
  request: Request,
  deps: ApiRouteDeps,
) => Response | Promise<Response | null> | null;
