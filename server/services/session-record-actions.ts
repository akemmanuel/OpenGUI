import type { HarnessId } from "@opengui/protocol";
import type { BackendServiceContext, SessionRecord, UpdateSessionInput } from "./index.ts";

export async function getSessionRecordOrThrow(input: {
  services: BackendServiceContext;
  sessionId: string;
  scope?: { directory?: string; harnessId?: HarnessId };
}): Promise<SessionRecord> {
  const session = await input.services.sessions.getSession(input.sessionId, input.scope ?? {});
  if (!session) throw new Error("Session not found");
  return session;
}

export async function updateSessionRecord(input: {
  services: BackendServiceContext;
  sessionId: string;
  patch: UpdateSessionInput;
}): Promise<SessionRecord | null> {
  return await input.services.sessions.updateSession(input.sessionId, input.patch);
}
