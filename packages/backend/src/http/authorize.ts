import type { IdentityService } from "../identity/identity.ts";
import type { Actor } from "../identity/types.ts";

export type AuthorizeOptions = {
  mode: "remote" | "desktop-local";
  identity?: IdentityService;
  legacyAuthToken?: string;
};

const localActor: Actor = {
  type: "local",
  id: "desktop-local",
  displayName: "",
  role: "owner",
};

export function createAuthorizer(options: AuthorizeOptions) {
  async function resolveActor(request: Request): Promise<Actor | null> {
    if (options.mode === "desktop-local") return localActor;
    const actor = await options.identity?.resolveActor(request);
    if (actor) return actor;

    // Upgrade bridge only: a configured legacy token stops working the moment an owner exists.
    if (options.legacyAuthToken && (await options.identity?.state()) === "setup") {
      const token = request.headers
        .get("authorization")
        ?.replace(/^Bearer\s+/i, "")
        .trim();
      if (token === options.legacyAuthToken) {
        return { type: "api_key", id: "legacy", displayName: "Legacy host token", role: "owner" };
      }
    }
    return null;
  }

  return { resolveActor };
}
