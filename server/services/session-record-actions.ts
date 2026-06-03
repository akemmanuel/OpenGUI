import type { HarnessId } from "../../src/agents/index.ts";
import type { BackendServiceContext, SessionRecord, UpdateSessionInput } from "./index.ts";

export async function getSessionRecordOrThrow(input: {
  services: BackendServiceContext;
  sessionId: string;
  scope?: { projectId?: string; harnessId?: HarnessId };
}): Promise<SessionRecord> {
  const session = await input.services.sessions.getSession(input.sessionId, input.scope ?? {});
  if (!session) throw new Error("Session not found");
  return session;
}

export async function listSessionRecords(input: {
  services: BackendServiceContext;
  projectId?: string;
  harnessId?: HarnessId;
  cursor?: string | null;
  limit?: number;
}) {
  return await input.services.sessions.listSessions({
    projectId: input.projectId,
    harnessId: input.harnessId,
    cursor: input.cursor,
    limit: input.limit,
  });
}

export async function updateSessionRecord(input: {
  services: BackendServiceContext;
  sessionId: string;
  patch: UpdateSessionInput;
}): Promise<SessionRecord | null> {
  return await input.services.sessions.updateSession(input.sessionId, input.patch);
}
