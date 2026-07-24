export type SessionShare = {
  granteeType: "user" | "team";
  granteeId: string;
  role: "view" | "run" | "admin";
  createdAt?: number;
};

export type SessionViewLink = {
  id: string;
  sessionId: string;
  token?: string;
  createdAt: number;
  expiresAt: number | null;
};

export type ModelEntitlement = {
  subjectType: "user" | "team";
  subjectId: string;
  modelId: string;
};

export type ModelPolicy = {
  host: { allowByok: boolean; allowByos: boolean };
  team: { allowByok: boolean; allowByos: boolean };
};

export type HostIdentityHealth = {
  ok: boolean;
  version: string;
  shell: string;
  identity: "setup" | "ready";
  authRequired: boolean;
};

export type IdentityActor = ActorSnapshot & {
  role: "owner" | "member";
};

export type IdentityUser = {
  id: string;
  username: string;
  email: string;
};

export type IdentitySession = {
  token: string;
  actor: IdentityActor;
  user: IdentityUser;
};

export type PathPolicyStatus = {
  mode: "disabled" | "enforced";
  revision: number;
  restricted: boolean;
  foundationReady: boolean;
  enforcementReady: boolean;
};

export type IdentityMe = {
  actor: IdentityActor;
  user: IdentityUser | null;
  pathPolicy: PathPolicyStatus;
};

export type PathGrant = {
  root: string;
  access: "read" | "write";
};

export type PathGrantSet = {
  subject: { type: "user" | "api_key"; id: string };
  revision: number;
  grants: PathGrant[];
};

export type TeamMember = {
  id: string;
  username: string;
  email: string;
  role: "owner" | "member";
  canInvite?: boolean;
  createdAt?: string | number;
};

export type TeamInvite = {
  id: string;
  email: string;
  role: "owner" | "member";
  createdAt?: string | number;
  expiresAt?: string | number;
  pathGrants?: PathGrant[];
};

export type CreatedTeamInvite = TeamInvite & { token: string };

export type HostRegistrationMode = "invite_only" | "open";

export type HostPublicPolicy = {
  registrationMode: HostRegistrationMode;
  identity: "setup" | "ready" | "local";
};

export type HostAdminPolicy = {
  registrationMode: HostRegistrationMode;
  pathGrantsMode?: "disabled" | "enforced";
};

export type HostApiKey = {
  id: string;
  label: string;
  role: "owner" | "member";
  createdAt?: string | number;
  lastUsedAt?: string | number | null;
};

export type CreatedHostApiKey = HostApiKey & { secret: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class IdentityRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "IdentityRequestError";
  }
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const text = await response.text();
  type Envelope = { ok?: boolean; value?: T; error?: string };
  let body: Envelope | null = null;
  try {
    body = text ? (JSON.parse(text) as Envelope) : null;
  } catch {
    body = null;
  }
  if (!response.ok || !body?.ok) {
    throw new IdentityRequestError(
      body?.error || `Host request failed (${response.status})`,
      response.status,
    );
  }
  return body.value as T;
}

export function createIdentityClient({
  baseUrl,
  token,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  token?: string;
  fetchImpl?: FetchLike;
}) {
  const base = baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (token && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return readEnvelope<T>(await fetchImpl(`${base}${path}`, { ...init, headers }));
  }

  return {
    health: () => request<HostIdentityHealth>("/api/host/health"),
    policy: () => request<HostPublicPolicy>("/api/identity/policy"),
    setup: (input: { username: string; email: string; password: string }) =>
      request<IdentitySession>("/api/identity/setup", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    login: (input: { username: string; password: string }) =>
      request<IdentitySession>("/api/identity/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    register: (input: { username: string; email: string; password: string }) =>
      request<IdentitySession>("/api/identity/register", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    logout: () => request<void>("/api/identity/logout", { method: "POST", body: "{}" }),
    me: () => request<IdentityMe>("/api/identity/me"),
    hostPolicy: () => request<HostAdminPolicy>("/api/identity/host-policy"),
    setHostPolicy: (input: { registrationMode: HostRegistrationMode }) =>
      request<HostAdminPolicy>("/api/identity/host-policy", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    accessibleRoots: () => request<string[]>("/api/fs/roots"),
    sharePrincipals: () =>
      request<{
        users: Array<{ id: string; name: string }>;
        teams: Array<{ id: string; name: string }>;
      }>("/api/identity/share-principals"),
    members: () => request<TeamMember[]>("/api/identity/members"),
    removeMember: (id: string) =>
      request<void>(`/api/identity/members/${encodeURIComponent(id)}`, { method: "DELETE" }),
    resetMemberPassword: (id: string, password: string) =>
      request<void>(`/api/identity/members/${encodeURIComponent(id)}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    setMemberCanInvite: (id: string, canInvite: boolean) =>
      request<{ id: string; canInvite: boolean }>(
        `/api/identity/members/${encodeURIComponent(id)}/can-invite`,
        {
          method: "PUT",
          body: JSON.stringify({ canInvite }),
        },
      ),
    invites: () => request<TeamInvite[]>("/api/identity/invites"),
    createInvite: (input: { email: string; role: "member"; pathGrants?: PathGrant[] }) =>
      request<CreatedTeamInvite>("/api/identity/invites", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    revokeInvite: (id: string) =>
      request<void>(`/api/identity/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
    acceptInvite: (input: { token: string; username: string; email: string; password: string }) =>
      request<IdentitySession>("/api/identity/invites/accept", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    sessionShares: (sessionId: string) =>
      request<SessionShare[]>(`/api/identity/sessions/${encodeURIComponent(sessionId)}/shares`),
    shareSession: (sessionId: string, input: Omit<SessionShare, "createdAt">) =>
      request<SessionShare>(`/api/identity/sessions/${encodeURIComponent(sessionId)}/shares`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    revokeSessionShare: (sessionId: string, granteeType: "user" | "team", granteeId: string) =>
      request<void>(
        `/api/identity/sessions/${encodeURIComponent(sessionId)}/shares/${granteeType}/${encodeURIComponent(granteeId)}`,
        { method: "DELETE" },
      ),
    sessionViewLinks: (sessionId: string) =>
      request<SessionViewLink[]>(
        `/api/identity/sessions/${encodeURIComponent(sessionId)}/view-links`,
      ),
    createSessionViewLink: (sessionId: string, expiresAt?: number | null) =>
      request<SessionViewLink & { token: string }>(
        `/api/identity/sessions/${encodeURIComponent(sessionId)}/view-links`,
        { method: "POST", body: JSON.stringify({ expiresAt }) },
      ),
    revokeSessionViewLink: (id: string) =>
      request<void>(`/api/identity/session-view-links/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    resolveSessionViewLink: (tokenValue: string) =>
      request<{
        sessionId: string;
        access: "view";
        session: import("@/protocol/host-types").HostSessionSnapshot;
      }>(`/api/identity/session-view-links/resolve?token=${encodeURIComponent(tokenValue)}`),
    modelPolicy: () => request<ModelPolicy>("/api/identity/model-policy"),
    setModelPolicy: (input: ModelPolicy) =>
      request<ModelPolicy>("/api/identity/model-policy", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    modelEntitlements: (connectionId: string) =>
      request<ModelEntitlement[]>(
        `/api/identity/model-connections/${encodeURIComponent(connectionId)}/entitlements`,
      ),
    replaceModelEntitlements: (connectionId: string, entitlements: ModelEntitlement[]) =>
      request<ModelEntitlement[]>(
        `/api/identity/model-connections/${encodeURIComponent(connectionId)}/entitlements`,
        { method: "PUT", body: JSON.stringify({ entitlements }) },
      ),
    apiKeys: () => request<HostApiKey[]>("/api/identity/api-keys"),
    createApiKey: (input: { label: string; role: "owner" | "member" }) =>
      request<CreatedHostApiKey>("/api/identity/api-keys", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    revokeApiKey: (id: string) =>
      request<void>(`/api/identity/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
    memberPathGrants: (id: string) =>
      request<PathGrantSet>(`/api/identity/members/${encodeURIComponent(id)}/path-grants`),
    replaceMemberPathGrants: (id: string, grants: PathGrant[]) =>
      request<PathGrantSet>(`/api/identity/members/${encodeURIComponent(id)}/path-grants`, {
        method: "PUT",
        body: JSON.stringify({ grants }),
      }),
    apiKeyPathGrants: (id: string) =>
      request<PathGrantSet>(`/api/identity/api-keys/${encodeURIComponent(id)}/path-grants`),
    replaceApiKeyPathGrants: (id: string, grants: PathGrant[]) =>
      request<PathGrantSet>(`/api/identity/api-keys/${encodeURIComponent(id)}/path-grants`, {
        method: "PUT",
        body: JSON.stringify({ grants }),
      }),
  };
}
import type { ActorSnapshot } from "@/protocol/host-types";
