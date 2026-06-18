import { readJsonBody, respondToHarnessPermission } from "../../../../server/services/index.ts";
import { isPlainObject, jsonError } from "../http/json.ts";
import type { ForwardedHandler } from "../http/types.ts";

export const handlePermissionRequest: ForwardedHandler = async (request, deps) => {
  const pathname = new URL(request.url).pathname;
  if (!pathname.endsWith("/respond") || !pathname.startsWith("/api/permissions/")) return null;
  const services = await deps.getServices();
  const permissionId = decodeURIComponent(
    pathname.slice("/api/permissions/".length, pathname.length - "/respond".length),
  );
  if (!permissionId) return new Response("Not found", { status: 404 });

  try {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await readJsonBody(request);
    if (
      !isPlainObject(body) ||
      typeof body.sessionId !== "string" ||
      typeof body.response !== "string"
    ) {
      throw new Error("sessionId and response are required");
    }
    const { session, scopeRef } = await deps.resolvePermissionSessionScope(services, body);
    await respondToHarnessPermission({
      services,
      session,
      permissionId,
      response: body.response as "once" | "always" | "reject",
      scope: { directory: scopeRef.canonicalPath || scopeRef.path },
    });
    return Response.json({ ok: true, value: true });
  } catch (error) {
    return jsonError(error, 400);
  }
};
