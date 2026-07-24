export const BACKEND_PACKAGE_ID = "@opengui/backend" as const;

export {
  createBackendHost,
  type BackendHost,
  type CreateBackendHostOptions,
} from "./create-backend-host.ts";
export { readBackendHostEnv, type BackendHostEnv } from "./host/env.ts";
export { createOpenGuiHost, OpenGuiHost } from "./host/opengui-host.ts";
export { createCorsAuth, type CorsAuthConfig } from "./http/cors-auth.ts";
export { createAuthorizer, type AuthorizeOptions } from "./http/authorize.ts";
export { IdentityService, type IdentityServiceOptions } from "./identity/identity.ts";
export type { Actor, HostRole, IdentityState } from "./identity/types.ts";
export {
  canonicalizeAllowedRoots,
  canonicalizeGrantRoot,
  containsPath,
  createEffectivePathPolicy,
  type CanonicalPathGrant,
  type EffectivePathPolicy,
  type PathGrantAccess,
  type PathPolicyDecision,
} from "./path-policy/path-policy.ts";
export { jsonError, isPlainObject } from "./http/json.ts";
