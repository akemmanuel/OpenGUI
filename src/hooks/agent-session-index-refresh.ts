import type { HarnessId } from "@/agents";
import type { OpenGuiClient } from "@/protocol/client";
import { makeProjectKey } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import type { SessionListTargetSource } from "@/hooks/agent-project-connection";

export type DispatchMergeProjectSessions = (payload: {
  projectKey: string;
  directory: string;
  sessions: Session[];
  harnessIds?: HarnessId[];
  source?: SessionListTargetSource;
}) => void;

export async function refreshProjectSessionIndex(input: {
  sessionsClient: OpenGuiClient["sessions"];
  dispatchMerge: DispatchMergeProjectSessions;
  workspaceId: string;
  directory: string;
  harnessId: HarnessId;
  source?: SessionListTargetSource;
  baseUrl?: string;
  authToken?: string;
}): Promise<{
  sessions: Session[];
  queryResult: Awaited<ReturnType<OpenGuiClient["sessions"]["query"]>>;
}> {
  const queryResult = await input.sessionsClient.query({
    projects: [
      {
        directory: input.directory,
        workspaceId: input.workspaceId,
        baseUrl: input.baseUrl,
        authToken: input.authToken,
      },
    ],
    harnessIds: [input.harnessId],
  });
  const sessions =
    queryResult.items.find((item) => item.harnessId === input.harnessId)?.sessions ?? [];
  input.dispatchMerge({
    projectKey: makeProjectKey(input.workspaceId, input.directory),
    directory: input.directory,
    sessions,
    harnessIds: [input.harnessId],
    source: input.source,
  });
  return { sessions, queryResult };
}
