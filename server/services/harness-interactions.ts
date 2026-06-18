import type { HarnessId } from "@opengui/protocol";
import type { QuestionAnswer } from "@opencode-ai/sdk/v2/client";
import type { BackendServiceContext, SessionRecord } from "./index.ts";

export async function respondToHarnessPermission(input: {
  services: BackendServiceContext;
  session: SessionRecord;
  permissionId: string;
  response: "once" | "always" | "reject";
  scope?: { directory?: string };
}): Promise<void> {
  await input.services.harnesses.respondPermission({
    session: input.session,
    permissionId: input.permissionId,
    response: input.response,
    scope: input.scope,
  });
}

export async function replyToHarnessQuestion(input: {
  services: BackendServiceContext;
  harnessId: HarnessId;
  requestId: string;
  answers: QuestionAnswer[];
  target?: { directory?: string };
}): Promise<void> {
  await input.services.harnesses.replyQuestion({
    harnessId: input.harnessId,
    requestId: input.requestId,
    answers: input.answers,
    target: input.target,
  });
}

export async function rejectHarnessQuestion(input: {
  services: BackendServiceContext;
  harnessId: HarnessId;
  requestId: string;
  target?: { directory?: string };
}): Promise<void> {
  await input.services.harnesses.rejectQuestion({
    harnessId: input.harnessId,
    requestId: input.requestId,
    target: input.target,
  });
}
