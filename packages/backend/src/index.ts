export const BACKEND_PACKAGE_ID = "@opengui/backend" as const;

export { registerProductApiRoutes } from "./create-api-app.ts";
export { createCorsAuth, type CorsAuthConfig } from "./http/cors-auth.ts";
export { jsonError, isPlainObject } from "./http/json.ts";
export type { ApiRouteDeps, ForwardedHandler } from "./http/types.ts";
export { handleDirectoryRequest } from "./routes/directory.ts";
export { handleHarnessRequest } from "./routes/harness.ts";
export { handlePermissionRequest } from "./routes/permission.ts";
export { handleQuestionRequest } from "./routes/question.ts";
export { handleSessionRequest } from "./routes/session.ts";
