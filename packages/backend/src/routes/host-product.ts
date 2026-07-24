import { HostSessionNotFoundError, type OpenGuiHost } from "../host/opengui-host.ts";
import { resolve } from "node:path";
import type { BackendApp } from "../http/request-context.ts";
import { isPlainObject, jsonError } from "../http/json.ts";
import { durableActor, type Actor, type IdentityState } from "../identity/types.ts";
import {
  IdentityError,
  type IdentityService,
  type ModelConnectionPlane,
} from "../identity/identity.ts";
import { HostPathAuthorizer, PathAuthorizationError } from "../path-policy/enforcement.ts";

function textField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

function sessionError(error: unknown) {
  return jsonError(
    error,
    error instanceof HostSessionNotFoundError
      ? 404
      : error instanceof IdentityError
        ? error.status
        : error instanceof PathAuthorizationError
          ? 403
          : 400,
  );
}

export function registerHostProductRoutes(
  app: BackendApp,
  input: {
    getHost: () => Promise<OpenGuiHost>;
    resolveSafeDirectory: (inputPath: string | null) => Promise<string>;
    pathAuthorizer?: HostPathAuthorizer;
    authRequired?: boolean;
    getIdentityState?: () => Promise<IdentityState>;
    identity?: IdentityService;
  },
) {
  const pathAuthorizer = input.pathAuthorizer ?? new HostPathAuthorizer();
  async function resolveRequestDirectory(
    actor: ReturnType<typeof durableActor>,
    requested: string,
  ) {
    const authorized = await pathAuthorizer.authorizePath(actor, resolve(requested), "read");
    return await input.resolveSafeDirectory(authorized);
  }

  app.get("/api/health", async () => {
    const host = await input.getHost();
    const authRequired = input.authRequired === true;
    const identity = (await input.getIdentityState?.()) ?? "local";
    return Response.json({
      ok: true,
      authRequired,
      identity,
      value: { ...host.health(), authRequired, identity },
    });
  });

  app.get("/api/host/health", async () => {
    const host = await input.getHost();
    const authRequired = input.authRequired === true;
    const identity = (await input.getIdentityState?.()) ?? "local";
    return Response.json({
      ok: true,
      authRequired,
      identity,
      value: { ...host.health(), authRequired, identity },
    });
  });

  app.get("/api/host/models", async (c) => {
    const host = await input.getHost();
    const all = host.listModelConnections();
    if (!input.identity) {
      return Response.json({
        ok: true,
        value: all.map((connection) => ({ ...connection, plane: "host" as const })),
      });
    }
    await input.identity.registerLegacyHostConnections(all.map((connection) => connection.id));
    const actor = c.get("actor") as Actor;
    const access = await input.identity.listModelConnectionAccess(actor);
    const byId = new Map(access.map((item) => [item.id, item]));
    return Response.json({
      ok: true,
      value: all.flatMap((connection) => {
        const metadata = byId.get(connection.id);
        return metadata ? [{ ...connection, ...metadata }] : [];
      }),
    });
  });
  app.get("/api/host/auth/codex", async () =>
    Response.json({ ok: true, value: (await input.getHost()).codexAuthStatus() }),
  );
  app.post("/api/host/auth/codex", async () => {
    try {
      return Response.json({ ok: true, value: await (await input.getHost()).beginCodexAuth() });
    } catch (error) {
      return jsonError(error, 400);
    }
  });
  app.post("/api/host/auth/codex/poll", async () => {
    try {
      return Response.json({ ok: true, value: await (await input.getHost()).pollCodexAuth() });
    } catch (error) {
      return jsonError(error, 400);
    }
  });
  app.delete("/api/host/auth/codex", async () => {
    await (await input.getHost()).disconnectCodex();
    return Response.json({ ok: true, value: true });
  });
  for (const provider of ["xai"] as const) {
    app.get(`/api/host/auth/${provider}`, async () =>
      Response.json({ ok: true, value: (await input.getHost()).subscriptionAuthStatus(provider) }),
    );
    app.post(`/api/host/auth/${provider}`, async () => {
      try {
        return Response.json({
          ok: true,
          value: await (await input.getHost()).beginSubscriptionAuth(provider),
        });
      } catch (error) {
        return jsonError(error, 400);
      }
    });
    app.post(`/api/host/auth/${provider}/poll`, async () => {
      try {
        return Response.json({
          ok: true,
          value: await (await input.getHost()).pollSubscriptionAuth(provider),
        });
      } catch (error) {
        return jsonError(error, 400);
      }
    });
    app.delete(`/api/host/auth/${provider}`, async () => {
      await (await input.getHost()).disconnectSubscription(provider);
      return Response.json({ ok: true, value: true });
    });
  }

  app.post("/api/host/models", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      if (!isPlainObject(body)) throw new Error("Request body must be an object");
      const id = textField(body, "id") || `connection_${Date.now()}`;
      const label = textField(body, "label") || "Custom OpenAI-compatible";
      const baseUrl = textField(body, "baseUrl");
      const apiKey = textField(body, "apiKey") || undefined;
      const modelIds = Array.isArray(body.modelIds)
        ? body.modelIds.filter(
            (item): item is string => typeof item === "string" && item.trim().length > 0,
          )
        : [];
      if (!baseUrl) throw new Error("baseUrl is required");
      if (modelIds.length === 0) throw new Error("modelIds must include at least one model");
      const actor = c.get("actor") as Actor;
      const requestedPlane = textField(body, "plane") as ModelConnectionPlane;
      const plane: ModelConnectionPlane = input.identity
        ? requestedPlane === "host" || requestedPlane === "team" || requestedPlane === "user"
          ? requestedPlane
          : actor.role === "owner"
            ? "host"
            : "user"
        : "host";
      const credentialKind = body.credentialKind === "byos" ? "byos" : "byok";
      const metadata = input.identity
        ? await input.identity.recordModelConnection(actor, { id, plane, credentialKind })
        : { plane: "host" as const };
      try {
        const connection = await host.upsertModelConnection({
          id,
          label,
          baseUrl,
          apiKey,
          modelIds,
        });
        return Response.json({ ok: true, value: { ...connection, ...metadata } });
      } catch (error) {
        if (input.identity)
          await input.identity.removeModelConnection(actor, id).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.delete("/api/host/models/:connectionId", async (c) => {
    try {
      const host = await input.getHost();
      const connectionId = c.req.param("connectionId");
      if (input.identity) {
        await input.identity.removeModelConnection(c.get("actor") as Actor, connectionId);
      }
      await host.removeModelConnection(connectionId);
      return Response.json({ ok: true, value: true });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.get("/api/host/projects", async (c) => {
    const host = await input.getHost();
    return Response.json({
      ok: true,
      value: await host.listProjects(durableActor(c.get("actor"))),
    });
  });

  app.post("/api/host/projects", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      const requested = textField(body, "directory");
      if (!requested) throw new Error("directory is required");
      const directory = await resolveRequestDirectory(durableActor(c.get("actor")), requested);
      return Response.json({
        ok: true,
        value: await host.registerProject(directory, durableActor(c.get("actor"))),
      });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.delete("/api/host/projects", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      const requested = textField(body, "directory");
      if (!requested) throw new Error("directory is required");
      const directory = await resolveRequestDirectory(durableActor(c.get("actor")), requested);
      await host.unregisterProject(directory, durableActor(c.get("actor")));
      return Response.json({ ok: true, value: true });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.get("/api/host/sessions", async (c) => {
    try {
      const host = await input.getHost();
      const directory = c.req.query("directory")?.trim();
      if (!directory) throw new Error("directory is required");
      const resolved = await resolveRequestDirectory(durableActor(c.get("actor")), directory);
      const actor = c.get("actor") as Actor;
      const sessions = await host.listSessions(resolved, durableActor(actor));
      const value = input.identity
        ? await Promise.all(
            sessions.map(async (session) => ({
              ...session,
              ...(await input.identity!.sessionAccessSummary(session.id, actor)),
            })),
          )
        : sessions;
      return Response.json({ ok: true, value });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.post("/api/host/sessions", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      if (!isPlainObject(body)) throw new Error("Request body must be an object");
      const requested = textField(body, "directory");
      if (!requested) throw new Error("directory is required");
      const directory = await resolveRequestDirectory(durableActor(c.get("actor")), requested);
      const model =
        body.model && isPlainObject(body.model)
          ? {
              connectionId: textField(body.model as Record<string, unknown>, "connectionId"),
              modelId: textField(body.model as Record<string, unknown>, "modelId"),
            }
          : { connectionId: "", modelId: "" };
      const reasoningRaw = textField(body, "reasoning") || "medium";
      const reasoning =
        reasoningRaw === "none" ||
        reasoningRaw === "minimal" ||
        reasoningRaw === "low" ||
        reasoningRaw === "medium" ||
        reasoningRaw === "high" ||
        reasoningRaw === "xhigh" ||
        reasoningRaw === "max" ||
        reasoningRaw === "ultra"
          ? reasoningRaw
          : "medium";
      const actor = c.get("actor") as Actor;
      if (input.identity && (!model.connectionId || !model.modelId)) {
        throw new Error("An entitled model connection is required");
      }
      if (input.identity) {
        await input.identity.authorizeModelSelection(actor, model.connectionId, model.modelId);
      }
      const session = await host.createSession(
        {
          projectDirectory: directory,
          title: textField(body, "title") || undefined,
          model,
          reasoning,
        },
        durableActor(actor),
      );
      if (input.identity && session.model?.connectionId) {
        await input.identity.pinSessionConnection(session.id, actor, session.model.connectionId);
      }
      return Response.json({ ok: true, value: session });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.get("/api/host/sessions/:sessionId", async (c) => {
    try {
      const host = await input.getHost();
      return Response.json({
        ok: true,
        value: await host.readSession(c.req.param("sessionId"), durableActor(c.get("actor"))),
      });
    } catch (error) {
      return jsonError(error, 404);
    }
  });

  app.patch("/api/host/sessions/:sessionId", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      if (!isPlainObject(body)) throw new Error("Request body must be an object");
      const sessionId = c.req.param("sessionId");
      if (typeof body.title === "string") {
        return Response.json({
          ok: true,
          value: await host.renameSession(sessionId, body.title, durableActor(c.get("actor"))),
        });
      }
      if (body.model && isPlainObject(body.model)) {
        const actor = c.get("actor") as Actor;
        const selection = {
          connectionId: textField(body.model as Record<string, unknown>, "connectionId"),
          modelId: textField(body.model as Record<string, unknown>, "modelId"),
        };
        if (input.identity) {
          await input.identity.authorizeModelSelection(
            actor,
            selection.connectionId,
            selection.modelId,
          );
        }
        const value = await host.setModel(sessionId, selection, durableActor(actor));
        if (input.identity) {
          await input.identity.pinSessionConnection(sessionId, actor, selection.connectionId);
        }
        return Response.json({ ok: true, value });
      }
      if (typeof body.reasoning === "string") {
        const reasoning = body.reasoning;
        if (
          reasoning !== "none" &&
          reasoning !== "minimal" &&
          reasoning !== "low" &&
          reasoning !== "medium" &&
          reasoning !== "high" &&
          reasoning !== "xhigh" &&
          reasoning !== "max" &&
          reasoning !== "ultra"
        ) {
          throw new Error("Invalid reasoning level");
        }
        return Response.json({
          ok: true,
          value: await host.setReasoning(sessionId, reasoning, durableActor(c.get("actor"))),
        });
      }
      throw new Error("No supported fields provided");
    } catch (error) {
      return sessionError(error);
    }
  });

  app.delete("/api/host/sessions/:sessionId", async (c) => {
    try {
      const host = await input.getHost();
      await host.deleteSession(c.req.param("sessionId"), durableActor(c.get("actor")));
      return Response.json({ ok: true, value: true });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.post("/api/host/sessions/:sessionId/prompt", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      const text = textField(body, "text");
      if (!text) throw new Error("text is required");
      const actor = c.get("actor") as Actor;
      const sessionId = c.req.param("sessionId");
      if (input.identity) {
        const snapshot = await host.readSession(sessionId, durableActor(actor));
        if (!snapshot.model) throw new Error("Session has no model connection");
        await input.identity.authorizeModelSelection(
          actor,
          snapshot.model.connectionId,
          snapshot.model.modelId,
        );
      }
      return Response.json({
        ok: true,
        value: await host.prompt(sessionId, {
          text,
          actor: durableActor(actor),
        }),
      });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.patch("/api/host/sessions/:sessionId/follow-ups/:followUpId", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      const text = textField(body, "text");
      if (!text) throw new Error("text is required");
      return Response.json({
        ok: true,
        value: await host.updateFollowUp(c.req.param("sessionId"), c.req.param("followUpId"), {
          text,
          actor: durableActor(c.get("actor")),
        }),
      });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.post("/api/host/sessions/:sessionId/follow-ups/:followUpId/reorder", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      if (typeof body.index !== "number" || !Number.isFinite(body.index)) {
        throw new Error("index is required");
      }
      return Response.json({
        ok: true,
        value: await (
          await input.getHost()
        ).reorderFollowUp(
          c.req.param("sessionId"),
          c.req.param("followUpId"),
          body.index,
          durableActor(c.get("actor")),
        ),
      });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.delete("/api/host/sessions/:sessionId/follow-ups/:followUpId", async (c) => {
    try {
      return Response.json({
        ok: true,
        value: await (
          await input.getHost()
        ).removeFollowUp(
          c.req.param("sessionId"),
          c.req.param("followUpId"),
          durableActor(c.get("actor")),
        ),
      });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.post("/api/host/sessions/:sessionId/follow-ups/:followUpId/send-now", async (c) => {
    try {
      return Response.json({
        ok: true,
        value: await (
          await input.getHost()
        ).sendFollowUpNow(
          c.req.param("sessionId"),
          c.req.param("followUpId"),
          durableActor(c.get("actor")),
        ),
      });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.post("/api/host/sessions/:sessionId/abort", async (c) => {
    try {
      const host = await input.getHost();
      await host.abort(c.req.param("sessionId"), durableActor(c.get("actor")));
      return Response.json({ ok: true, value: true });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.get("/api/host/events", async (c) => {
    const host = await input.getHost();
    const actor = durableActor(c.get("actor"));
    const sessionId = c.req.query("sessionId")?.trim();
    const restricted = await host.requiresScopedEvents(actor);
    if (restricted && !sessionId) {
      return Response.json(
        { ok: false, error: "sessionId is required", code: "PATH_NOT_AUTHORIZED" },
        { status: 403 },
      );
    }
    let unsubscribe: () => void;
    const pendingEvents: unknown[] = [];
    let sendEvent: (event: unknown) => void = (event) => {
      pendingEvents.push(event);
    };
    try {
      unsubscribe = await host.subscribe(actor, sessionId, (event) => {
        sendEvent(event);
      });
    } catch (error) {
      return sessionError(error);
    }
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };
        sendEvent = send;
        send({ type: "ready" });
        for (const event of pendingEvents) send(event);
        pendingEvents.length = 0;
        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe();
          controller.close();
        });
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });
}
