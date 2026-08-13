import {
  HostSessionNotFoundError,
  MODEL_OFFERING_CONNECTION_ID,
  type OpenGuiHost,
} from "../host/opengui-host.ts";
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
import { SkillManagementError } from "../host/skills-management.ts";

function textField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

function skillScope(value: unknown) {
  if (value === "project" || value === "host") return value;
  throw new Error("scope must be project or host");
}

function skillManagementActor(actor: Actor) {
  if (
    actor.type !== "local" &&
    (actor.type !== "user" || (actor.role !== "owner" && actor.role !== "admin"))
  ) {
    throw new IdentityError("FORBIDDEN", 403, "Human Host administrator access required");
  }
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

function skillError(error: unknown) {
  if (!(error instanceof SkillManagementError)) return sessionError(error);
  const conflict = [
    "GENERATION_CONFLICT",
    "LOCALLY_MODIFIED",
    "ALREADY_EXISTS",
    "IDEMPOTENCY_CONFLICT",
  ].includes(error.code);
  return Response.json(
    { ok: false, error: error.message, code: error.code, recoverable: true },
    { status: conflict ? 409 : 400 },
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
    await input.identity.migrateLegacyModelOfferings(all);
    const actor = c.get("actor") as Actor;
    const access = await input.identity.listModelConnectionAccess(actor);
    const byId = new Map(access.map((item) => [item.id, item]));
    const visible = await Promise.all(
      all.map(async (connection) => {
        const metadata = byId.get(connection.id);
        if (!metadata) return null;
        const modelIds = await input.identity!.visibleLegacyModelIds(
          actor,
          connection.id,
          connection.modelIds,
        );
        if (modelIds.length === 0) return null;
        const modelCapabilities = connection.modelCapabilities
          ? Object.fromEntries(
              Object.entries(connection.modelCapabilities).filter(([modelId]) =>
                modelIds.includes(modelId),
              ),
            )
          : undefined;
        const defaultModelId = modelIds.includes(connection.defaultModelId ?? "")
          ? connection.defaultModelId
          : modelIds[0];
        if (
          actor.type === "user" &&
          (actor.role === "owner" || actor.role === "admin" || metadata.plane === "user")
        ) {
          return { ...connection, ...metadata, modelIds, defaultModelId, modelCapabilities };
        }
        return {
          ...metadata,
          label: connection.label,
          modelIds,
          defaultModelId,
          modelCapabilities,
        };
      }),
    );
    return Response.json({
      ok: true,
      value: visible.filter((connection) => connection !== null),
    });
  });
  app.get("/api/host/model-offerings", async (c) => {
    if (!input.identity) return Response.json({ ok: true, value: [] });
    const host = await input.getHost();
    await input.identity.migrateLegacyModelOfferings(host.listModelConnections());
    return Response.json({
      ok: true,
      value: await input.identity.listModelOfferings(c.get("actor") as Actor),
    });
  });
  app.get("/api/host/auth/codex", async () =>
    Response.json({ ok: true, value: (await input.getHost()).codexAuthStatus() }),
  );
  app.post("/api/host/auth/codex", async () => {
    try {
      return Response.json({ ok: true, value: await (await input.getHost()).beginCodexAuth() });
    } catch (error) {
      return sessionError(error);
    }
  });
  app.post("/api/host/auth/codex/poll", async () => {
    try {
      return Response.json({ ok: true, value: await (await input.getHost()).pollCodexAuth() });
    } catch (error) {
      return sessionError(error);
    }
  });
  app.post("/api/host/auth/codex/cancel", async () =>
    Response.json({ ok: true, value: await (await input.getHost()).cancelCodexAuth() }),
  );
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
    app.post(`/api/host/auth/${provider}/cancel`, async () =>
      Response.json({
        ok: true,
        value: await (await input.getHost()).cancelSubscriptionAuth(provider),
      }),
    );
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
        ? body.modelIds
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
      if (!baseUrl) throw new Error("baseUrl is required");
      if (modelIds.length === 0) throw new Error("modelIds must include at least one model");
      let parsedBaseUrl: URL;
      try {
        parsedBaseUrl = new URL(baseUrl);
      } catch {
        throw new Error("baseUrl must be a valid HTTP or HTTPS URL");
      }
      if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:")
        throw new Error("baseUrl must be a valid HTTP or HTTPS URL");
      if (new Set(modelIds).size !== modelIds.length)
        throw new Error("modelIds must not contain duplicates");
      const routes = ["openai-chat", "anthropic-messages", "responses"] as const;
      const rawModelRoutes = isPlainObject(body.modelRoutes) ? body.modelRoutes : null;
      const modelRoutes = rawModelRoutes
        ? Object.fromEntries(
            modelIds.flatMap((modelId) => {
              const route = rawModelRoutes[modelId];
              return typeof route === "string" && routes.includes(route as (typeof routes)[number])
                ? [[modelId, route as (typeof routes)[number]]]
                : [];
            }),
          )
        : undefined;
      const rawModelCapabilities = isPlainObject(body.modelCapabilities)
        ? body.modelCapabilities
        : null;
      const modelCapabilities = rawModelCapabilities
        ? Object.fromEntries(
            modelIds.flatMap((modelId) => {
              const raw = rawModelCapabilities[modelId];
              if (!isPlainObject(raw)) return [];
              const context =
                typeof raw.context === "number" && Number.isInteger(raw.context) && raw.context > 0
                  ? raw.context
                  : undefined;
              const displayName =
                typeof raw.displayName === "string" && raw.displayName.trim()
                  ? raw.displayName.trim()
                  : undefined;
              const reasoningEfforts = Array.isArray(raw.reasoningEfforts)
                ? raw.reasoningEfforts.filter(
                    (
                      effort,
                    ): effort is
                      | "none"
                      | "minimal"
                      | "low"
                      | "medium"
                      | "high"
                      | "xhigh"
                      | "max"
                      | "ultra" =>
                      typeof effort === "string" &&
                      [
                        "none",
                        "minimal",
                        "low",
                        "medium",
                        "high",
                        "xhigh",
                        "max",
                        "ultra",
                      ].includes(effort),
                  )
                : undefined;
              return [
                [
                  modelId,
                  {
                    displayName,
                    context,
                    reasoning: raw.reasoning === true,
                    ...(reasoningEfforts?.length ? { reasoningEfforts } : {}),
                  },
                ],
              ];
            }),
          )
        : undefined;
      const defaultModelId =
        typeof body.defaultModelId === "string" && modelIds.includes(body.defaultModelId)
          ? body.defaultModelId
          : modelIds[0];
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
      const previousMetadata = input.identity
        ? await input.identity.modelConnectionMetadataForMutation(actor, id)
        : null;
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
          defaultModelId,
          modelRoutes,
          modelCapabilities,
        });
        return Response.json({ ok: true, value: { ...connection, ...metadata } });
      } catch (error) {
        if (input.identity) {
          if (previousMetadata) {
            await input.identity
              .recordModelConnection(actor, {
                id: previousMetadata.id,
                plane: previousMetadata.plane,
                credentialKind: previousMetadata.credentialKind,
              })
              .catch(() => undefined);
          } else {
            await input.identity.removeModelConnection(actor, id).catch(() => undefined);
          }
        }
        throw error;
      }
    } catch (error) {
      return sessionError(error);
    }
  });

  app.delete("/api/host/models/:connectionId", async (c) => {
    try {
      const host = await input.getHost();
      const connectionId = c.req.param("connectionId");
      if (input.identity) {
        // Authorize before touching Host state, then delete the durable Host
        // half first. The following SQLite delete is synchronous and cannot
        // strand endpoint/secrets when a Host write fails.
        await input.identity.authorizeModelConnectionRemoval(c.get("actor") as Actor, connectionId);
      }
      await host.removeModelConnection(connectionId);
      if (input.identity) {
        await input.identity.removeModelConnection(c.get("actor") as Actor, connectionId);
      }
      return Response.json({ ok: true, value: true });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.get("/api/host/mcp-connections", async () => {
    const host = await input.getHost();
    return Response.json({ ok: true, value: await host.listMcpConnections() });
  });

  app.post("/api/host/mcp-connections", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      if (!isPlainObject(body) || !isPlainObject(body.transport)) {
        throw new Error("Request body and transport must be objects");
      }
      const id = textField(body, "id");
      const label = textField(body, "label");
      if (!id || !label) throw new Error("id and label are required");
      const enabled = body.enabled !== false;
      const transport = body.transport;
      if (transport.kind === "stdio") {
        if (body.commandApproved !== true) {
          throw new Error("The exact MCP server command must be approved before saving");
        }
        const command = textField(transport, "command");
        if (!command) throw new Error("command is required");
        const args = Array.isArray(transport.args)
          ? transport.args.filter((item): item is string => typeof item === "string")
          : [];
        const env = isPlainObject(transport.env)
          ? Object.fromEntries(
              Object.entries(transport.env).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : undefined;
        return Response.json({
          ok: true,
          value: await (
            await input.getHost()
          ).upsertMcpConnection({
            id,
            label,
            enabled,
            transport: {
              kind: "stdio",
              command,
              args,
              ...(textField(transport, "cwd") ? { cwd: textField(transport, "cwd") } : {}),
              ...(env ? { env } : {}),
            },
          }),
        });
      }
      if (transport.kind !== "http") throw new Error("transport kind must be stdio or http");
      const url = textField(transport, "url");
      if (!url) throw new Error("url is required");
      return Response.json({
        ok: true,
        value: await (
          await input.getHost()
        ).upsertMcpConnection({
          id,
          label,
          enabled,
          transport: {
            kind: "http",
            url,
            ...(textField(transport, "bearerToken")
              ? { bearerToken: textField(transport, "bearerToken") }
              : {}),
          },
        }),
      });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.post("/api/host/mcp-connections/:connectionId/inspect", async (c) => {
    try {
      return Response.json({
        ok: true,
        value: await (
          await input.getHost()
        ).inspectMcpConnection(c.req.param("connectionId"), durableActor(c.get("actor") as Actor)),
      });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.delete("/api/host/mcp-connections/:connectionId", async (c) => {
    try {
      await (await input.getHost()).removeMcpConnection(c.req.param("connectionId"));
      return Response.json({ ok: true, value: true });
    } catch (error) {
      return sessionError(error);
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

  app.get("/api/host/skills", async (c) => {
    try {
      const host = await input.getHost();
      const directory = c.req.query("directory")?.trim();
      if (!directory) throw new Error("directory is required");
      const resolved = await resolveRequestDirectory(durableActor(c.get("actor")), directory);
      return Response.json({
        ok: true,
        value: await host.listSkills(resolved, durableActor(c.get("actor"))),
      });
    } catch (error) {
      return sessionError(error);
    }
  });

  app.get("/api/host/skills/sources", async () =>
    Response.json({ ok: true, value: (await input.getHost()).supportedSkillSources() }),
  );

  app.get("/api/host/skills/installations", async (c) => {
    try {
      skillManagementActor(c.get("actor") as Actor);
      const scope = skillScope(c.req.query("scope"));
      const directory = c.req.query("directory")?.trim() ?? "";
      if (scope === "project" && !directory) throw new Error("directory is required");
      return Response.json({
        ok: true,
        value: await (
          await input.getHost()
        ).listSkillInstallations(directory, scope, durableActor(c.get("actor"))),
      });
    } catch (error) {
      return skillError(error);
    }
  });

  app.post("/api/host/skills/install", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      if (!isPlainObject(body)) throw new Error("Request body must be an object");
      const source = textField(body, "source");
      const directory = textField(body, "directory");
      const scope =
        body.scope === undefined
          ? body.global === true
            ? "host"
            : "project"
          : skillScope(body.scope);
      const requestId = textField(body, "requestId");
      const expectedGeneration = body.expectedGeneration;
      const actor = c.get("actor") as Actor;
      if (!source || !requestId || (scope === "project" && !directory))
        throw new Error("source, requestId, and project directory are required");
      if (
        expectedGeneration !== undefined &&
        (!Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0)
      )
        throw new Error("expectedGeneration must be a non-negative integer");
      skillManagementActor(actor);
      return Response.json({
        ok: true,
        value: await (
          await input.getHost()
        ).installSkill({
          source,
          projectDirectory: directory,
          scope,
          requestId,
          ...(typeof expectedGeneration === "number" ? { expectedGeneration } : {}),
          actor: durableActor(actor),
        }),
      });
    } catch (error) {
      return skillError(error);
    }
  });

  app.post("/api/host/skills/:name/update", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      if (!isPlainObject(body)) throw new Error("Request body must be an object");
      const scope = skillScope(body.scope);
      const directory = textField(body, "directory");
      const requestId = textField(body, "requestId");
      const expectedGeneration = body.expectedGeneration;
      const actor = c.get("actor") as Actor;
      if (!requestId || (scope === "project" && !directory))
        throw new Error("requestId and project directory are required");
      if (
        expectedGeneration !== undefined &&
        (!Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0)
      )
        throw new Error("expectedGeneration must be a non-negative integer");
      skillManagementActor(actor);
      return Response.json({
        ok: true,
        value: await (
          await input.getHost()
        ).updateSkill({
          name: c.req.param("name"),
          projectDirectory: directory,
          scope,
          requestId,
          ...(typeof expectedGeneration === "number" ? { expectedGeneration } : {}),
          actor: durableActor(actor),
        }),
      });
    } catch (error) {
      return skillError(error);
    }
  });

  app.delete("/api/host/skills/:name", async (c) => {
    try {
      const directory = c.req.query("directory")?.trim() ?? "";
      const scope = c.req.query("scope")
        ? skillScope(c.req.query("scope"))
        : c.req.query("global") === "true"
          ? "host"
          : "project";
      const requestId = c.req.query("requestId")?.trim() ?? "";
      const expectedRaw = c.req.query("expectedGeneration");
      const expectedGeneration = expectedRaw === undefined ? undefined : Number(expectedRaw);
      const actor = c.get("actor") as Actor;
      if (!requestId || (scope === "project" && !directory))
        throw new Error("requestId and project directory are required");
      if (
        expectedGeneration !== undefined &&
        (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
      )
        throw new Error("expectedGeneration must be a non-negative integer");
      skillManagementActor(actor);
      await (
        await input.getHost()
      ).removeSkill({
        name: c.req.param("name"),
        projectDirectory: directory,
        scope,
        requestId,
        ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
        actor: durableActor(actor),
      });
      return Response.json({ ok: true, value: true });
    } catch (error) {
      return skillError(error);
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

  app.post("/api/host/session-message-search", async (c) => {
    try {
      const host = await input.getHost();
      const body = (await c.req.json()) as Record<string, unknown>;
      if (!isPlainObject(body)) throw new Error("Request body must be an object");
      const query = textField(body, "query");
      const directories = Array.isArray(body.directories)
        ? Array.from(
            new Set(
              body.directories
                .map((directory) => (typeof directory === "string" ? directory.trim() : ""))
                .filter(Boolean),
            ),
          )
        : [];
      if (directories.length === 0) throw new Error("directories are required");
      if (directories.length > 200) throw new Error("at most 200 directories may be searched");
      if (!query) return Response.json({ ok: true, value: [] });
      if (query.length > 500) throw new Error("query must be at most 500 characters");
      const actor = durableActor(c.get("actor"));
      const resolved = await Promise.all(
        directories.map((directory) => resolveRequestDirectory(actor, directory)),
      );
      const value = await host.searchSessionMessages(resolved, query, actor);
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
      if (input.identity && actor.role === "viewer") {
        throw new IdentityError("FORBIDDEN", 403, "Viewer access is read-only");
      }
      if (input.identity && (!model.connectionId || !model.modelId)) {
        throw new Error("An entitled model connection is required");
      }
      if (input.identity) {
        if (model.connectionId === MODEL_OFFERING_CONNECTION_ID)
          await input.identity.authorizeModelOffering(actor, model.modelId);
        else await input.identity.authorizeModelSelection(actor, model.connectionId, model.modelId);
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
      try {
        if (input.identity && session.model?.connectionId) {
          if (session.model.connectionId === MODEL_OFFERING_CONNECTION_ID)
            await input.identity.pinSessionOffering(session.id, actor, session.model.modelId);
          else
            await input.identity.pinSessionConnection(
              session.id,
              actor,
              session.model.connectionId,
            );
        }
      } catch (error) {
        await host.deleteSession(session.id, durableActor(actor)).catch(() => undefined);
        throw error;
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
        const previous = await host.readSession(sessionId, durableActor(actor));
        const selection = {
          connectionId: textField(body.model as Record<string, unknown>, "connectionId"),
          modelId: textField(body.model as Record<string, unknown>, "modelId"),
        };
        if (input.identity) {
          if (selection.connectionId === MODEL_OFFERING_CONNECTION_ID)
            await input.identity.authorizeModelOffering(actor, selection.modelId);
          else
            await input.identity.authorizeModelSelection(
              actor,
              selection.connectionId,
              selection.modelId,
            );
        }
        const value = await host.setModel(sessionId, selection, durableActor(actor));
        try {
          if (input.identity) {
            if (selection.connectionId === MODEL_OFFERING_CONNECTION_ID)
              await input.identity.pinSessionOffering(sessionId, actor, selection.modelId);
            else
              await input.identity.pinSessionConnection(sessionId, actor, selection.connectionId);
          }
        } catch (error) {
          if (previous.model) {
            await host
              .setModel(sessionId, previous.model, durableActor(actor))
              .catch(() => undefined);
          }
          throw error;
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

  app.post("/api/host/sessions/:sessionId/compact", async (c) => {
    try {
      const host = await input.getHost();
      const actor = c.get("actor") as Actor;
      const sessionId = c.req.param("sessionId");
      if (input.identity) {
        const snapshot = await host.readSession(sessionId, durableActor(actor));
        if (!snapshot.model) throw new Error("Session has no model connection");
        if (snapshot.model.connectionId === MODEL_OFFERING_CONNECTION_ID)
          await input.identity.authorizeModelOffering(actor, snapshot.model.modelId);
        else
          await input.identity.authorizeModelSelection(
            actor,
            snapshot.model.connectionId,
            snapshot.model.modelId,
          );
      }
      return Response.json({
        ok: true,
        value: await host.compact(sessionId, durableActor(actor)),
      });
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
      const skills = Array.isArray(body.skills)
        ? body.skills
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : undefined;
      const interrupt = body.interrupt === true;
      const actor = c.get("actor") as Actor;
      const sessionId = c.req.param("sessionId");
      if (input.identity) {
        const snapshot = await host.readSession(sessionId, durableActor(actor));
        if (!snapshot.model) throw new Error("Session has no model connection");
        if (snapshot.model.connectionId === MODEL_OFFERING_CONNECTION_ID)
          await input.identity.authorizeModelOffering(actor, snapshot.model.modelId);
        else
          await input.identity.authorizeModelSelection(
            actor,
            snapshot.model.connectionId,
            snapshot.model.modelId,
          );
      }
      const prompt = {
        text,
        // `skills: []` must stay distinct from omitted skills (Host defaults).
        ...(skills !== undefined ? { skills } : {}),
        actor: durableActor(actor),
      };
      return Response.json({
        ok: true,
        value: interrupt
          ? await host.prompt(sessionId, prompt, prompt.actor, { interrupt: true })
          : await host.prompt(sessionId, prompt),
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
