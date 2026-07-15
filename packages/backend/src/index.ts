export const BACKEND_PACKAGE_ID = "@opengui/backend" as const;

export {
  createBackendHost,
  type BackendHost,
  type CreateBackendHostOptions,
} from "./create-backend-host.ts";
export { readBackendHostEnv, type BackendHostEnv } from "./host/env.ts";
export { createOpenGuiHost, OpenGuiHost } from "./host/opengui-host.ts";
export { createCorsAuth, type CorsAuthConfig } from "./http/cors-auth.ts";
export { jsonError, isPlainObject } from "./http/json.ts";
