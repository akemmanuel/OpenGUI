import type { HarnessId } from "@opengui/protocol";
import {
  toOptionalString,
  getDirectoryHarnessStatus,
  loadDirectoryHarnessResources,
  readJsonBody,
  registerDirectoryWithHarnesses,
  releaseDirectoryFromHarnesses,
} from "../../../../server/services/index.ts";
import { isPlainObject, jsonError } from "../http/json.ts";
import type { ForwardedHandler } from "../http/types.ts";

export const handleDirectoryRequest: ForwardedHandler = async (request, deps) => {
  const services = await deps.getServices();
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/directories/")) return null;

  const subpath = pathname.slice("/api/directories/".length);
  const [directoryEncoded, child] = subpath.split("/");
  const directoryRaw = decodeURIComponent(directoryEncoded ?? "");
  if (!directoryRaw) return new Response("Not found", { status: 404 });

  try {
    const directory = (await deps.resolveHarnessDirectoryForSessions({ directory: directoryRaw }))
      .canonicalPath;

    if (child === "register") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      const harnessIds =
        isPlainObject(body) && Array.isArray(body.harnessIds)
          ? body.harnessIds.filter((value): value is HarnessId => typeof value === "string")
          : undefined;
      const config = isPlainObject(body) && isPlainObject(body.config) ? body.config : body;
      const rawBaseUrl = isPlainObject(config)
        ? toOptionalString(config.baseUrl, "baseUrl")
        : undefined;
      const harnessBaseUrl = rawBaseUrl
        ? new URL(rawBaseUrl).origin === url.origin
          ? `http://127.0.0.1:${process.env.OPENGUI_OPENCODE_PORT?.trim() || "4096"}`
          : rawBaseUrl
        : undefined;
      return Response.json({
        ok: true,
        value: await registerDirectoryWithHarnesses({
          services,
          directory,
          harnessIds,
          config: {
            directory,
            baseUrl: harnessBaseUrl,
            username: isPlainObject(config)
              ? toOptionalString(config.username, "username")
              : undefined,
            password: isPlainObject(config)
              ? toOptionalString(config.password, "password")
              : undefined,
          },
        }),
      });
    }

    if (child === "release") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const body = await readJsonBody(request);
      const harnessIds =
        isPlainObject(body) && Array.isArray(body.harnessIds)
          ? body.harnessIds.filter((value): value is HarnessId => typeof value === "string")
          : undefined;
      await releaseDirectoryFromHarnesses({ services, directory, harnessIds });
      return Response.json({ ok: true, value: true });
    }

    if (child === "status") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const harnessId = (url.searchParams.get("harnessId") as HarnessId | null) ?? undefined;
      return Response.json({
        ok: true,
        value: await getDirectoryHarnessStatus({ services, directory, harnessId }),
      });
    }

    if (child && ["providers", "models", "agents", "commands"].includes(child)) {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const harnessId = url.searchParams.get("harnessId") as HarnessId | null;
      if (!harnessId) return jsonError(new Error("harnessId is required"), 400);
      const resources = await loadDirectoryHarnessResources({
        services,
        directory,
        harnessId,
      });
      if (child === "providers") return Response.json({ ok: true, value: resources.providersData });
      if (child === "agents") return Response.json({ ok: true, value: resources.agentsData });
      if (child === "commands") return Response.json({ ok: true, value: resources.commandsData });
      const models = Array.isArray(resources.providersData?.providers)
        ? resources.providersData.providers.flatMap(
            (provider: { id: string; models?: Record<string, Record<string, unknown>> }) =>
              Object.entries(provider.models ?? {}).map(([modelId, model]) => ({
                ...model,
                providerID: provider.id,
                modelID: modelId,
              })),
          )
        : [];
      return Response.json({ ok: true, value: models });
    }

    return new Response("Not found", { status: 404 });
  } catch (error) {
    return jsonError(error, 400);
  }
};
