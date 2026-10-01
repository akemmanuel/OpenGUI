import { Hono } from "hono";
import { expect, test, vi } from "vite-plus/test";
import type { BackendRequestEnv } from "../http/request-context.ts";
import type { OpenGuiHost } from "../host/opengui-host.ts";
import type { IdentityService } from "../identity/identity.ts";
import type { Actor } from "../identity/types.ts";
import { registerHostProductRoutes } from "./host-product.ts";

for (const actor of [
  { type: "api_key", id: "key", role: "admin", displayName: "Key" },
  { type: "user", id: "viewer", role: "viewer", displayName: "Viewer" },
] as Actor[]) {
  test(`${actor.type}/${actor.role} cannot edit project instructions even with a team allow`, async () => {
    const setProjectInstructions = vi.fn();
    const getPersonalInstructions = vi.fn();
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/host/*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    registerHostProductRoutes(app, {
      getHost: async () =>
        ({
          getProjectInstructions: async () => ({
            directory: "/repo",
            text: "Rules",
            teamEditors: { frontend: true },
          }),
          setProjectInstructions,
          getPersonalInstructions,
        }) as unknown as OpenGuiHost,
      resolveSafeDirectory: async (path) => path!,
      identity: {
        instructionTeams: async () => [{ id: "frontend", name: "Frontend", member: true }],
      } as unknown as IdentityService,
    });
    const response = await app.request("/api/host/project-instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: "/repo", text: "Injected", canEdit: true }),
    });
    expect(response.status).toBe(403);
    expect(setProjectInstructions).not.toHaveBeenCalled();
    if (actor.type === "api_key") {
      expect((await app.request("/api/host/personal-instructions")).status).toBe(403);
      expect(getPersonalInstructions).not.toHaveBeenCalled();
    }
  });
}
