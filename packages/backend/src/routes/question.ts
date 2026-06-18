import type { HarnessId } from "@opengui/protocol";
import {
  readJsonBody,
  rejectHarnessQuestion,
  replyToHarnessQuestion,
  toOptionalString,
  toQuestionAnswers,
} from "../../../../server/services/index.ts";
import { isPlainObject, jsonError } from "../http/json.ts";
import type { ForwardedHandler } from "../http/types.ts";

export const handleQuestionRequest: ForwardedHandler = async (request, deps) => {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/^\/api\/questions\/([^/]+)\/(reply|reject)$/);
  if (!match) return null;
  const services = await deps.getServices();
  const questionId = decodeURIComponent(match[1] ?? "");
  const action = match[2];
  if (!questionId || !action) return new Response("Not found", { status: 404 });

  try {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await readJsonBody(request);
    const harnessId = (
      isPlainObject(body)
        ? (toOptionalString(body.harnessId, "harnessId") ?? "claude-code")
        : "claude-code"
    ) as HarnessId;
    const sessionId = isPlainObject(body)
      ? toOptionalString(body.sessionId, "sessionId")
      : undefined;
    const bodyDirectory = isPlainObject(body)
      ? (toOptionalString(body.directory, "directory") ??
        toOptionalString(body.projectId, "projectId"))
      : undefined;
    let directory = bodyDirectory;
    if (!directory && sessionId) {
      const session = await deps.getSessionOrThrow(services, sessionId, {
        harnessId,
      });
      directory = (await deps.getSessionDirectoryScopeOrThrow(services, session)).path;
    } else if (directory) {
      directory = (await deps.resolveHarnessDirectoryForSessions({ directory })).canonicalPath;
    }
    const target = directory ? { directory } : undefined;
    if (action === "reply") {
      if (!isPlainObject(body) || body.answers === undefined) {
        throw new Error("answers is required for question reply");
      }
      const answers = toQuestionAnswers(body.answers);
      if (answers.length === 0) {
        throw new Error("answers must be a non-empty array");
      }
      await replyToHarnessQuestion({
        services,
        harnessId,
        requestId: questionId,
        answers,
        target,
      });
    } else {
      await rejectHarnessQuestion({ services, harnessId, requestId: questionId, target });
    }
    return Response.json({ ok: true, value: true });
  } catch (error) {
    return jsonError(error, 400);
  }
};
