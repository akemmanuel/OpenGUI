import type { BackendApp } from "../http/request-context.ts";
import { IdentityError, type IdentityService } from "../identity/identity.ts";
import type { Actor, HostRole } from "../identity/types.ts";
import { isPlainObject } from "../http/json.ts";

type IdentityRouteDeps = {
  mode: "remote" | "desktop-local";
  identity?: IdentityService;
  getActor: (request: Request) => Promise<Actor | null>;
  readSessionForViewLink?: (sessionId: string) => Promise<unknown>;
};

function credentials(body: Record<string, unknown>) {
  return {
    username: typeof body.username === "string" ? body.username.trim() : "",
    email: typeof body.email === "string" ? body.email.trim().toLowerCase() : "",
    password: typeof body.password === "string" ? body.password : "",
  };
}

function authRequired() {
  return Response.json(
    { ok: false, error: "Unauthorized", code: "AUTH_REQUIRED", recoverable: true },
    { status: 401 },
  );
}

function invalidRequest(message: string) {
  return Response.json(
    { ok: false, error: message, code: "INVALID_REQUEST", recoverable: true },
    { status: 400 },
  );
}

async function identityOperation(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return value instanceof Response ? value : Response.json({ ok: true, value });
  } catch (error) {
    if (error instanceof IdentityError) {
      return Response.json(
        { ok: false, error: error.message, code: error.code, recoverable: error.status < 500 },
        { status: error.status },
      );
    }
    console.error("Identity operation failed", error);
    return Response.json(
      { ok: false, error: "Identity operation failed", code: "IDENTITY_OPERATION_FAILED" },
      { status: 500 },
    );
  }
}

async function requestBody(request: Request) {
  const body = (await request.json().catch(() => null)) as unknown;
  return isPlainObject(body) ? body : null;
}

export function registerIdentityRoutes(app: BackendApp, deps: IdentityRouteDeps) {
  app.post("/api/identity/setup", async (c) => {
    if (deps.mode !== "remote" || !deps.identity) {
      return Response.json(
        { ok: false, error: "Identity is disabled for Desktop Local Host" },
        { status: 404 },
      );
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (!isPlainObject(body))
      return Response.json({ ok: false, error: "Invalid request body" }, { status: 400 });
    const input = credentials(body);
    if (!input.username || !input.email || !input.password) {
      return Response.json(
        { ok: false, error: "username, email, and password are required" },
        { status: 400 },
      );
    }
    return await deps.identity.setup({ ...input, headers: c.req.raw.headers });
  });

  const login = async (request: Request) => {
    if (deps.mode !== "remote" || !deps.identity) return authRequired();
    const body = (await request.json().catch(() => null)) as unknown;
    if (!isPlainObject(body))
      return Response.json({ ok: false, error: "Invalid request body" }, { status: 400 });
    const input = credentials(body);
    if (!input.username || !input.password) {
      return Response.json(
        { ok: false, error: "username and password are required" },
        { status: 400 },
      );
    }
    return await deps.identity.login(input.username, input.password, request.headers);
  };
  app.post("/api/identity/login", (c) => login(c.req.raw));
  app.post("/api/auth/login", (c) => login(c.req.raw));

  app.get("/api/identity/policy", async () => {
    if (deps.mode !== "remote" || !deps.identity) {
      return Response.json({
        ok: true,
        value: { registrationMode: "invite_only", identity: "local" },
      });
    }
    return await identityOperation(() => deps.identity!.publicPolicy());
  });

  app.post("/api/identity/register", async (c) => {
    if (deps.mode !== "remote" || !deps.identity) return authRequired();
    const body = await requestBody(c.req.raw);
    if (!body) return invalidRequest("Invalid request body");
    const input = credentials(body);
    if (!input.username || !input.email || !input.password) {
      return invalidRequest("username, email, and password are required");
    }
    return await deps.identity.register({ ...input, headers: c.req.raw.headers });
  });

  app.post("/api/identity/invites/accept", async (c) => {
    if (deps.mode !== "remote" || !deps.identity) return authRequired();
    const body = await requestBody(c.req.raw);
    if (!body) return invalidRequest("Invalid request body");
    const input = credentials(body);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token || !input.username || !input.email || !input.password) {
      return invalidRequest("token, username, email, and password are required");
    }
    return await identityOperation(() =>
      deps.identity!.acceptInvite({ ...input, token, headers: c.req.raw.headers }),
    );
  });

  const logout = async (request: Request) => {
    if (!deps.identity || !(await deps.getActor(request))) return authRequired();
    return await deps.identity.logout(request.headers);
  };
  app.post("/api/identity/logout", (c) => logout(c.req.raw));
  app.post("/api/auth/logout", (c) => logout(c.req.raw));

  const me = async (request: Request) => {
    if (deps.mode === "desktop-local") {
      return Response.json({
        ok: true,
        value: {
          actor: await deps.getActor(request),
          user: null,
          pathPolicy: {
            mode: "disabled",
            revision: 0,
            restricted: false,
            foundationReady: true,
            enforcementReady: false,
          },
        },
      });
    }
    const value = await deps.identity?.me(request);
    return value ? Response.json({ ok: true, value }) : authRequired();
  };
  app.get("/api/identity/me", (c) => me(c.req.raw));
  app.get("/api/auth/me", (c) => me(c.req.raw));

  app.get("/api/identity/audit", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    if (actor.type !== "user" || actor.role !== "owner") {
      return Response.json(
        { ok: false, error: "Owner access required", code: "FORBIDDEN" },
        { status: 403 },
      );
    }
    const limitValue = c.req.query("limit");
    const beforeValue = c.req.query("before");
    const limit = limitValue === undefined ? undefined : Number(limitValue);
    const beforeId = beforeValue === undefined ? undefined : Number(beforeValue);
    if (
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) ||
      (beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId < 1))
    ) {
      return invalidRequest("limit and before must be positive integers");
    }
    return await identityOperation(() => deps.identity!.listAudit(actor, { limit, beforeId }));
  });

  app.get("/api/identity/host-policy", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(() => deps.identity!.getHostPolicy(actor));
  });

  app.put("/api/identity/host-policy", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    const body = await requestBody(c.req.raw);
    if (!body) return invalidRequest("Invalid request body");
    if (body.registrationMode !== "invite_only" && body.registrationMode !== "open") {
      return invalidRequest("registrationMode must be invite_only or open");
    }
    return await identityOperation(() =>
      deps.identity!.setRegistrationMode(actor, body.registrationMode as "invite_only" | "open"),
    );
  });

  app.post("/api/identity/invites", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    const body = await requestBody(c.req.raw);
    if (!body) return invalidRequest("Invalid request body");
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const expiresAt =
      typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
        ? body.expiresAt
        : undefined;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return invalidRequest("A valid email is required");
    }
    const pathGrants: { root: string; access: "read" | "write" }[] = [];
    if (body.pathGrants !== undefined) {
      if (!Array.isArray(body.pathGrants)) return invalidRequest("pathGrants must be an array");
      for (const value of body.pathGrants) {
        if (
          !isPlainObject(value) ||
          typeof value.root !== "string" ||
          !value.root.trim() ||
          (value.access !== "read" && value.access !== "write")
        ) {
          return invalidRequest("each path grant requires a root and read or write access");
        }
        pathGrants.push({ root: value.root.trim(), access: value.access });
      }
    }
    return await identityOperation(async () => {
      const value = await deps.identity!.createInvite(actor, { email, expiresAt, pathGrants });
      return Response.json({ ok: true, value }, { status: 201 });
    });
  });

  app.get("/api/identity/invites", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(() => deps.identity!.listInvites(actor));
  });

  app.delete("/api/identity/invites/:id", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(async () => {
      await deps.identity!.revokeInvite(actor, c.req.param("id"));
      return { revoked: true };
    });
  });

  app.get("/api/identity/share-principals", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(() => deps.identity!.listSharePrincipals(actor));
  });

  app.get("/api/identity/members", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(() => deps.identity!.listMembers(actor));
  });

  app.delete("/api/identity/members/:id", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(async () => {
      await deps.identity!.removeMember(actor, c.req.param("id"), c.req.raw.headers);
      return { removed: true };
    });
  });

  app.post("/api/identity/members/:id/reset-password", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    const body = await requestBody(c.req.raw);
    if (!body) return invalidRequest("Invalid request body");
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) return invalidRequest("password is required");
    return await identityOperation(async () => {
      await deps.identity!.resetMemberPassword(
        actor,
        c.req.param("id"),
        password,
        c.req.raw.headers,
      );
      return { reset: true };
    });
  });

  app.put("/api/identity/members/:id/can-invite", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    const body = await requestBody(c.req.raw);
    if (!body || typeof body.canInvite !== "boolean") {
      return invalidRequest("canInvite boolean is required");
    }
    return await identityOperation(() =>
      deps.identity!.setMemberCanInvite(actor, c.req.param("id"), body.canInvite as boolean),
    );
  });

  app.get("/api/identity/sessions/:sessionId/shares", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(() =>
      deps.identity!.listSessionShares(actor, c.req.param("sessionId")),
    );
  });

  app.post("/api/identity/sessions/:sessionId/shares", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    const body = await requestBody(c.req.raw);
    if (!body) return invalidRequest("Invalid request body");
    if (
      (body.granteeType !== "user" && body.granteeType !== "team") ||
      typeof body.granteeId !== "string" ||
      !body.granteeId.trim() ||
      (body.role !== "view" && body.role !== "run" && body.role !== "admin")
    ) {
      return invalidRequest("granteeType, granteeId, and role are required");
    }
    const granteeType = body.granteeType as "user" | "team";
    const granteeId = String(body.granteeId).trim();
    const role = body.role as "view" | "run" | "admin";
    return await identityOperation(async () => {
      const value = await deps.identity!.shareSession(actor, c.req.param("sessionId"), {
        granteeType,
        granteeId,
        role,
      });
      return Response.json({ ok: true, value }, { status: 201 });
    });
  });

  app.delete("/api/identity/sessions/:sessionId/shares/:granteeType/:granteeId", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    const granteeType = c.req.param("granteeType");
    if (granteeType !== "user" && granteeType !== "team") {
      return invalidRequest("granteeType must be user or team");
    }
    return await identityOperation(() =>
      deps.identity!.revokeSessionShare(
        actor,
        c.req.param("sessionId"),
        granteeType,
        c.req.param("granteeId"),
      ),
    );
  });

  app.get("/api/identity/sessions/:sessionId/view-links", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(() =>
      deps.identity!.listSessionViewLinks(actor, c.req.param("sessionId")),
    );
  });

  app.post("/api/identity/sessions/:sessionId/view-links", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    const body = (await requestBody(c.req.raw)) ?? {};
    const expiresAt =
      body.expiresAt === null
        ? null
        : typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
          ? body.expiresAt
          : undefined;
    return await identityOperation(async () => {
      const value = await deps.identity!.createSessionViewLink(actor, c.req.param("sessionId"), {
        expiresAt,
      });
      return Response.json({ ok: true, value }, { status: 201 });
    });
  });

  app.delete("/api/identity/session-view-links/:id", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(() =>
      deps.identity!.revokeSessionViewLink(actor, c.req.param("id")),
    );
  });

  app.get("/api/identity/session-view-links/resolve", async (c) => {
    if (!deps.identity) return authRequired();
    const token = c.req.query("token")?.trim() ?? "";
    if (!token) return invalidRequest("token is required");
    return await identityOperation(async () => {
      const link = await deps.identity!.resolveSessionViewLink(token);
      if (!deps.readSessionForViewLink) return link;
      const session = await deps.readSessionForViewLink(link.sessionId);
      return { ...link, session, access: "view" as const };
    });
  });

  app.get("/api/identity/model-policy", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(() => deps.identity!.getModelPolicy(actor));
  });

  app.put("/api/identity/model-policy", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    const body = await requestBody(c.req.raw);
    if (
      !body ||
      !isPlainObject(body.host) ||
      !isPlainObject(body.team) ||
      typeof body.host.allowByok !== "boolean" ||
      typeof body.host.allowByos !== "boolean" ||
      typeof body.team.allowByok !== "boolean" ||
      typeof body.team.allowByos !== "boolean"
    ) {
      return invalidRequest("host and team BYOK/BYOS policy booleans are required");
    }
    const host = body.host as Record<string, unknown>;
    const team = body.team as Record<string, unknown>;
    return await identityOperation(() =>
      deps.identity!.setModelPolicy(actor, {
        host: {
          allowByok: host.allowByok as boolean,
          allowByos: host.allowByos as boolean,
        },
        team: {
          allowByok: team.allowByok as boolean,
          allowByos: team.allowByos as boolean,
        },
      }),
    );
  });

  app.get("/api/identity/model-connections/:id/entitlements", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(() =>
      deps.identity!.listModelEntitlements(actor, c.req.param("id")),
    );
  });

  app.put("/api/identity/model-connections/:id/entitlements", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    const body = await requestBody(c.req.raw);
    if (!body || !Array.isArray(body.entitlements))
      return invalidRequest("entitlements must be an array");
    const entitlements: Array<{
      subjectType: "user" | "team";
      subjectId: string;
      modelId?: string;
    }> = [];
    for (const item of body.entitlements) {
      if (
        !isPlainObject(item) ||
        (item.subjectType !== "user" && item.subjectType !== "team") ||
        typeof item.subjectId !== "string" ||
        !item.subjectId.trim() ||
        (item.modelId !== undefined && typeof item.modelId !== "string")
      )
        return invalidRequest("each entitlement requires subjectType and subjectId");
      entitlements.push({
        subjectType: item.subjectType as "user" | "team",
        subjectId: item.subjectId.trim(),
        modelId: typeof item.modelId === "string" ? item.modelId.trim() : undefined,
      });
    }
    return await identityOperation(() =>
      deps.identity!.replaceModelEntitlements(actor, c.req.param("id"), entitlements),
    );
  });

  app.post("/api/identity/api-keys", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    if (actor.type !== "user" || actor.role !== "owner") {
      return Response.json(
        { ok: false, error: "Owner access required", code: "FORBIDDEN" },
        { status: 403 },
      );
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (!isPlainObject(body))
      return Response.json({ ok: false, error: "Invalid request body" }, { status: 400 });
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (body.role !== undefined && body.role !== "owner" && body.role !== "member") {
      return Response.json({ ok: false, error: "role must be owner or member" }, { status: 400 });
    }
    const role: HostRole = body.role === "owner" ? "owner" : "member";
    if (!label) return Response.json({ ok: false, error: "label is required" }, { status: 400 });
    const expiresAt =
      typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
        ? body.expiresAt
        : undefined;
    return await identityOperation(async () => {
      const value = await deps.identity!.mintApiKey(actor, { label, role, expiresAt });
      return Response.json({ ok: true, value }, { status: 201 });
    });
  });

  app.get("/api/identity/api-keys", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(() => deps.identity!.listApiKeys(actor));
  });

  app.delete("/api/identity/api-keys/:id", async (c) => {
    const actor = await deps.getActor(c.req.raw);
    if (!actor) return authRequired();
    return await identityOperation(async () => {
      await deps.identity!.revokeApiKey(actor, c.req.param("id"));
      return { revoked: true };
    });
  });

  const registerPathGrantRoutes = (
    route: "members" | "api-keys",
    subjectType: "user" | "api_key",
  ) => {
    app.get(`/api/identity/${route}/:id/path-grants`, async (c) => {
      const actor = await deps.getActor(c.req.raw);
      if (!actor) return authRequired();
      return await identityOperation(() =>
        deps.identity!.listPathGrants(actor, subjectType, c.req.param("id")),
      );
    });

    app.put(`/api/identity/${route}/:id/path-grants`, async (c) => {
      const actor = await deps.getActor(c.req.raw);
      if (!actor) return authRequired();
      const body = await requestBody(c.req.raw);
      if (!body || !Array.isArray(body.grants)) {
        return invalidRequest("grants must be an array");
      }
      const grants: { root: string; access: "read" | "write" }[] = [];
      for (const value of body.grants) {
        if (
          !isPlainObject(value) ||
          typeof value.root !== "string" ||
          !value.root.trim() ||
          (value.access !== "read" && value.access !== "write")
        ) {
          return invalidRequest("each grant requires a root and read or write access");
        }
        grants.push({ root: value.root.trim(), access: value.access });
      }
      return await identityOperation(() =>
        deps.identity!.replacePathGrants(actor, subjectType, c.req.param("id"), grants),
      );
    });
  };

  registerPathGrantRoutes("members", "user");
  registerPathGrantRoutes("api-keys", "api_key");
}
