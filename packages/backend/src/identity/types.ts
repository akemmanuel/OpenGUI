export type HostRole = "owner" | "member";

export type Actor = {
  type: "user" | "api_key" | "local";
  id: string;
  displayName: string;
  role: HostRole;
};

export function durableActor(actor: Actor) {
  return {
    type: actor.type,
    id: actor.id,
    displayName: actor.displayName,
  };
}

export type IdentityState = "setup" | "ready" | "local";
