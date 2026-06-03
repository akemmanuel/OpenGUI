import type { QuestionAnswer } from "@opencode-ai/sdk/v2/client";
import type { HarnessId } from "../../src/agents/index.ts";
import type { BackendServiceContext, SessionRecord } from "./index.ts";

export async function respondToHarnessPermission(input: {
  services: BackendServiceContext;
  session: SessionRecord;
  permissionId: string;
  response: "once" | "always" | "reject";
}): Promise<void> {
  await input.services.harnesses.respondPermission({
    session: input.session,
    permissionId: input.permissionId,
    response: input.response,
  });
}

export async function replyToHarnessQuestion(input: {
  services: BackendServiceContext;
  harnessId: HarnessId;
  requestId: string;
  answers: QuestionAnswer[];
}): Promise<void> {
  await input.services.harnesses.replyQuestion({
    harnessId: input.harnessId,
    requestId: input.requestId,
    answers: input.answers,
  });
}

export async function rejectHarnessQuestion(input: {
  services: BackendServiceContext;
  harnessId: HarnessId;
  requestId: string;
}): Promise<void> {
  await input.services.harnesses.rejectQuestion({
    harnessId: input.harnessId,
    requestId: input.requestId,
  });
}
