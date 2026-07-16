import type { Hono } from "hono";
import type { OpenGuiHost } from "../host/opengui-host.ts";
import { isPlainObject, jsonError } from "../http/json.ts";

function textField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

export function registerHostProductRoutes(
  app: Hono,
  input: {
    getHost: () => Promise<OpenGuiHost>;
    resolveSafeDirectory: (inputPath: string | null) => Promise<string>;
    authRequired?: boolean;
  },
) {
  app.get("/api/health", async () => {
    const host = await input.getHost();
    return Response.json({
      ok: true,
      authRequired: input.authRequired === true,
      value: host.health(),
    });
  });

  app.get("/api/host/health", async () => {
    const host = await input.getHost();
    return Response.json({ ok: true, value: host.health() });
  });

  app.get("/api/host/models", async () => {
    const host = await input.getHost();
    return Response.json({ ok: true, value: host.listModelConnections() });
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
      const connection = await host.upsertModelConnection({
        id,
        label,
        baseUrl,
        apiKey,
        modelIds,
      });
      return Response.json({ ok: true, value: connection });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.delete("/api/host/models/:connectionId", async (c) => {
    try {
      const host = await input.getHost();
      await host.removeModelConnection(c.req.param("connectionId"));
      return Response.json({ ok: true, value: true });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.get("/api/host/projects", async () => {
    const host = await input.getHost();
    return Response.json({ ok: true, value: host.listProjects() });
  });

  app.post("/api/host/projects", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      const directory = await input.resolveSafeDirectory(textField(body, "directory") || null);
      return Response.json({ ok: true, value: await host.registerProject(directory) });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.delete("/api/host/projects", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      const directory = await input.resolveSafeDirectory(textField(body, "directory") || null);
      await host.unregisterProject(directory);
      return Response.json({ ok: true, value: true });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.get("/api/host/sessions", async (c) => {
    try {
      const host = await input.getHost();
      const directory = c.req.query("directory")?.trim();
      if (!directory) throw new Error("directory is required");
      const resolved = await input.resolveSafeDirectory(directory);
      return Response.json({ ok: true, value: await host.listSessions(resolved) });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.post("/api/host/sessions", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      if (!isPlainObject(body)) throw new Error("Request body must be an object");
      const directory = await input.resolveSafeDirectory(textField(body, "directory") || null);
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
      const session = await host.createSession({
        projectDirectory: directory,
        title: textField(body, "title") || undefined,
        model,
        reasoning,
      });
      return Response.json({ ok: true, value: session });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.get("/api/host/sessions/:sessionId", async (c) => {
    try {
      const host = await input.getHost();
      return Response.json({
        ok: true,
        value: await host.readSession(c.req.param("sessionId")),
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
          value: await host.renameSession(sessionId, body.title),
        });
      }
      if (body.model && isPlainObject(body.model)) {
        return Response.json({
          ok: true,
          value: await host.setModel(sessionId, {
            connectionId: textField(body.model as Record<string, unknown>, "connectionId"),
            modelId: textField(body.model as Record<string, unknown>, "modelId"),
          }),
        });
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
          value: await host.setReasoning(sessionId, reasoning),
        });
      }
      throw new Error("No supported fields provided");
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.delete("/api/host/sessions/:sessionId", async (c) => {
    try {
      const host = await input.getHost();
      await host.deleteSession(c.req.param("sessionId"));
      return Response.json({ ok: true, value: true });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.post("/api/host/sessions/:sessionId/prompt", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      const text = textField(body, "text");
      if (!text) throw new Error("text is required");
      return Response.json({
        ok: true,
        value: await host.prompt(c.req.param("sessionId"), { text }),
      });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.post("/api/host/sessions/:sessionId/abort", async (c) => {
    try {
      const host = await input.getHost();
      await host.abort(c.req.param("sessionId"));
      return Response.json({ ok: true, value: true });
    } catch (error) {
      return jsonError(error, 400);
    }
  });

  app.get("/api/host/events", async (c) => {
    const host = await input.getHost();
    const sessionId = c.req.query("sessionId")?.trim();
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };
        send({ type: "ready" });
        const unsubscribe = host.subscribe((event) => {
          if (sessionId && event.sessionId !== sessionId) return;
          send(event);
        });
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
