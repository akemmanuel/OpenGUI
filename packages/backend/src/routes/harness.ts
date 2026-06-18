import { listManagedHarnessDescriptors } from "../../../../server/services/index.ts";
import type { ForwardedHandler } from "../http/types.ts";

export const handleHarnessRequest: ForwardedHandler = async (request, deps) => {
  const services = await deps.getServices();
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/api/harnesses") return null;
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  return Response.json({
    ok: true,
    value: listManagedHarnessDescriptors({ services }),
  });
};
