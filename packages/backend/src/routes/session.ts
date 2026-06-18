import type { HarnessId } from "@opengui/protocol";
import { isManagedHarnessId } from "@opengui/runtime";
import {
  abortSessionThroughHarness,
  asSessionStatus,
  compactSessionThroughHarness,
  createDirectorySessionThroughHarness,
  deleteSessionThroughHarness,
  enqueueSessionPrompt,
  forkSessionThroughHarness,
  listDirectorySessionQueues,
  listSessionMessagesThroughHarness,
  listSessionQueue,
  listSessionsForRequest,
  querySessionsFromFrontendProjects,
  readJsonBody,
  removeSessionPrompt,
  renameSessionThroughHarness,
  reorderSessionPrompt,
  revertSessionThroughHarness,
  sendCommandThroughHarness,
  sendQueuedPromptNow,
  submitSessionPrompt,
  toOptionalNullableString,
  toOptionalSelectedModel,
  toOptionalString,
  toQueueMode,
  unrevertSessionThroughHarness,
  updateSessionPrompt,
  updateSessionRecord,
} from "../../../../server/services/index.ts";
import { isPlainObject, jsonError } from "../http/json.ts";
import type { ForwardedHandler } from "../http/types.ts";

export const handleSessionRequest: ForwardedHandler = async (request, deps) => {
  const services = await deps.getServices();
  const url = new URL(request.url);
  const pathname = url.pathname;
  const sessionScope = deps.parseSessionScopeFromUrl(url);

  if (pathname === "/api/sessions/query") {
    try {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      if (!isPlainObject(body)) throw new Error("Request body must be an object");
      const value = await querySessionsFromFrontendProjects({
        services,
        body,
        isHarnessId: isManagedHarnessId,
        resolveDirectory: (directory) => deps.resolveHarnessDirectoryForSessions({ directory }),
      });
      return Response.json({ ok: true, value });
    } catch (error) {
      return jsonError(error, 400);
    }
  }

  if (pathname === "/api/queues") {
    try {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const directoryParam =
        url.searchParams.get("directory")?.trim() ||
        url.searchParams.get("projectId")?.trim() ||
        undefined;
      const harnessId = (url.searchParams.get("harnessId") as HarnessId | null) ?? undefined;
      if (!directoryParam || !harnessId) {
        throw new Error("directory and harnessId are required");
      }
      const resolvedDirectory = (
        await deps.resolveHarnessDirectoryForSessions({ directory: directoryParam })
      ).canonicalPath;
      return Response.json({
        ok: true,
        value: await listDirectorySessionQueues({
          services,
          directory: resolvedDirectory,
          harnessId,
        }),
      });
    } catch (error) {
      return jsonError(error, 400);
    }
  }

  if (pathname === "/api/sessions") {
    try {
      if (request.method === "GET") {
        const directory = url.searchParams.get("directory")?.trim() || undefined;
        const harnessId = (url.searchParams.get("harnessId") as HarnessId | null) ?? undefined;
        const directoryParam =
          directory ?? (url.searchParams.get("projectId")?.trim() || undefined);
        return Response.json({
          ok: true,
          value: await listSessionsForRequest({
            services,
            directory: directoryParam,
            harnessId,
            resolveDirectory: (dir) => deps.resolveHarnessDirectoryForSessions({ directory: dir }),
          }),
        });
      }

      if (request.method === "POST") {
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) throw new Error("Request body must be an object");
        const directory =
          toOptionalString(body.directory, "directory") ??
          toOptionalString(body.projectId, "projectId");
        const harnessId = toOptionalString(body.harnessId, "harnessId") as HarnessId | undefined;
        if (!harnessId) throw new Error("harnessId is required");
        if (!directory) throw new Error("directory is required");
        const resolvedDirectory = await deps.resolveHarnessDirectoryForSessions({ directory });
        const session = await createDirectorySessionThroughHarness({
          services,
          ...resolvedDirectory,
          harnessId,
          title: toOptionalString(body.title, "title"),
        });
        return Response.json({ ok: true, value: session });
      }

      return new Response("Method Not Allowed", { status: 405 });
    } catch (error) {
      return jsonError(error, 400);
    }
  }

  if (!pathname.startsWith("/api/sessions/")) return null;
  const subpath = pathname.slice("/api/sessions/".length);
  const [sessionIdEncoded, child, grandchild, action] = subpath.split("/");
  const sessionId = decodeURIComponent(sessionIdEncoded ?? "");
  if (!sessionId) return new Response("Not found", { status: 404 });

  try {
    if (!child) {
      if (request.method === "GET") {
        return Response.json({
          ok: true,
          value: await deps.getSessionForRead(services, sessionId, sessionScope),
        });
      }
      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) throw new Error("Request body must be an object");
        const existing = await deps.getSessionOrThrow(services, sessionId, sessionScope);
        const scopeRef = await deps.getSessionDirectoryScopeOrThrow(services, existing);
        const updated =
          typeof body.title === "string"
            ? await renameSessionThroughHarness({
                services,
                scopeRef,
                session: existing,
                title: body.title,
              })
            : await updateSessionRecord({
                services,
                sessionId,
                patch: {
                  title: toOptionalString(body.title, "title"),
                  status: asSessionStatus(body.status),
                  metadata: isPlainObject(body.metadata) ? body.metadata : undefined,
                },
              });
        if (!updated) return jsonError(new Error("Session not found"), 404);
        return Response.json({ ok: true, value: updated });
      }
      if (request.method === "DELETE") {
        const existing = await deps.getSessionOrThrow(services, sessionId, sessionScope);
        const qScope = await deps.sessionQueueScope(existing);
        const queuedPrompts = await listSessionQueue({
          services,
          sessionId: existing.id,
          directory: qScope.directory,
          harnessId: qScope.harnessId,
        });
        const confirmedQueueDelete =
          url.searchParams.get("confirmQueue") === "1" ||
          url.searchParams.get("confirmQueue") === "true";
        if (queuedPrompts.length > 0 && !confirmedQueueDelete) {
          return jsonError(
            new Error("Session has queued prompts; confirmQueue=true is required"),
            409,
          );
        }
        await deleteSessionThroughHarness({
          services,
          scopeRef: await deps.getSessionDirectoryScopeOrThrow(services, existing),
          session: existing,
        });
        return Response.json({ ok: true, value: true });
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    const existing =
      child === "messages" && request.method === "GET"
        ? await deps.getSessionForRead(services, sessionId, sessionScope)
        : await deps.getSessionOrThrow(services, sessionId, sessionScope);
    const scopeRef = await deps.getSessionDirectoryScopeOrThrow(services, existing);
    const qScope = await deps.sessionQueueScope(existing);

    if (child === "queue") {
      if (!grandchild) {
        if (request.method === "GET") {
          return Response.json({
            ok: true,
            value: await listSessionQueue({
              services,
              sessionId,
              directory: qScope.directory,
              harnessId: qScope.harnessId,
            }),
          });
        }
        if (request.method === "POST") {
          const body = await readJsonBody(request);
          if (!isPlainObject(body) || typeof body.text !== "string") {
            throw new Error("text is required");
          }
          return Response.json({
            ok: true,
            value: await enqueueSessionPrompt({
              services,
              sessionId,
              text: body.text,
              model: toOptionalSelectedModel(body.model),
              agent: toOptionalString(body.agent, "agent"),
              variant: toOptionalString(body.variant, "variant"),
              mode: toQueueMode(body.mode, "queue"),
              insertAt: body.insertAt === "front" ? "front" : "back",
              directory: qScope.directory,
              harnessId: qScope.harnessId,
            }),
          });
        }
        return new Response("Method Not Allowed", { status: 405 });
      }

      const entryId = decodeURIComponent(grandchild);
      if (!entryId) return new Response("Not found", { status: 404 });

      if (action === "reorder") {
        if (request.method !== "PATCH") return new Response("Method Not Allowed", { status: 405 });
        const body = await readJsonBody(request);
        if (!isPlainObject(body) || typeof body.index !== "number") {
          throw new Error("index is required");
        }
        return Response.json({
          ok: true,
          value: await reorderSessionPrompt({
            services,
            sessionId,
            entryId,
            index: body.index,
            directory: qScope.directory,
            harnessId: qScope.harnessId,
          }),
        });
      }

      if (action === "send-now") {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
        return Response.json({
          ok: true,
          value: await sendQueuedPromptNow({
            services,
            scopeRef,
            session: existing,
            entryId,
          }),
        });
      }

      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) throw new Error("Request body must be an object");
        return Response.json({
          ok: true,
          value: await updateSessionPrompt({
            services,
            sessionId,
            entryId,
            text: toOptionalString(body.text, "text"),
            model: toOptionalSelectedModel(body.model),
            agent: toOptionalNullableString(body.agent, "agent"),
            variant: toOptionalNullableString(body.variant, "variant"),
            mode: toQueueMode(body.mode),
            directory: qScope.directory,
            harnessId: qScope.harnessId,
          }),
        });
      }

      if (request.method === "DELETE") {
        return Response.json({
          ok: true,
          value: await removeSessionPrompt({
            services,
            sessionId,
            entryId,
            directory: qScope.directory,
            harnessId: qScope.harnessId,
          }),
        });
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    if (child === "messages") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const direction = url.searchParams.get("direction") || "older";
      const cursor = url.searchParams.get("cursor");
      const limit = url.searchParams.get("limit");
      return Response.json({
        ok: true,
        value: await listSessionMessagesThroughHarness({
          services,
          scopeRef,
          session: existing,
          options: {
            limit: limit ? Number(limit) : undefined,
            before: direction === "older" ? cursor : null,
          },
        }),
      });
    }

    if (child === "prompt") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      if (!isPlainObject(body) || typeof body.text !== "string")
        throw new Error("text is required");
      await submitSessionPrompt({
        services,
        scopeRef,
        session: existing,
        text: body.text,
        model: toOptionalSelectedModel(body.model),
        agent: toOptionalString(body.agent, "agent"),
        variant: toOptionalString(body.variant, "variant"),
        mode: toQueueMode(body.mode, "queue"),
      });
      return Response.json({ ok: true, value: true });
    }

    if (child === "command") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      if (!isPlainObject(body) || typeof body.command !== "string") {
        throw new Error("command is required");
      }
      await sendCommandThroughHarness({
        services,
        scopeRef,
        session: existing,
        command: body.command,
        args: typeof body.args === "string" ? body.args : "",
        model: toOptionalSelectedModel(body.model),
        agent: toOptionalString(body.agent, "agent"),
        variant: toOptionalString(body.variant, "variant"),
      });
      return Response.json({ ok: true, value: true });
    }

    if (child === "abort") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      await abortSessionThroughHarness({ services, scopeRef, session: existing });
      return Response.json({ ok: true, value: true });
    }

    if (child === "fork") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      const session = await forkSessionThroughHarness({
        services,
        scopeRef,
        session: existing,
        messageId: isPlainObject(body) ? toOptionalString(body.messageId, "messageId") : undefined,
      });
      return Response.json({ ok: true, value: session });
    }

    if (child === "compact") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      await compactSessionThroughHarness({
        services,
        scopeRef,
        session: existing,
        model: isPlainObject(body) ? toOptionalSelectedModel(body.model) : undefined,
      });
      return Response.json({ ok: true, value: true });
    }

    if (child === "revert") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      if (!isPlainObject(body) || typeof body.messageId !== "string") {
        throw new Error("messageId is required");
      }
      const session = await revertSessionThroughHarness({
        services,
        scopeRef,
        session: existing,
        messageId: body.messageId,
        partId: toOptionalString(body.partId, "partId"),
      });
      if (session) return Response.json({ ok: true, value: session });
      return Response.json({ ok: true, value: true });
    }

    if (child === "unrevert") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const session = await unrevertSessionThroughHarness({
        services,
        scopeRef,
        session: existing,
      });
      if (session) return Response.json({ ok: true, value: session });
      return Response.json({ ok: true, value: true });
    }

    return new Response("Not found", { status: 404 });
  } catch (error) {
    return jsonError(error, 400);
  }
};
