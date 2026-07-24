import type { HostIdentityHealth, IdentityActor } from "./identity-client";

export function ownerSettingsVisibility(actor: IdentityActor | null, localBypass: boolean) {
  const ownerUser = actor?.type === "user" && actor.role === "owner";
  return {
    providers: localBypass || ownerUser,
    team: ownerUser && !localBypass,
  };
}

export type IdentityGateState =
  | { status: "checking" }
  | { status: "setup"; health: HostIdentityHealth }
  | { status: "login"; health: HostIdentityHealth }
  | { status: "authenticated"; health?: HostIdentityHealth }
  | { status: "error"; message: string };

export type IdentityGateAction =
  | { type: "check" }
  | { type: "health"; health: HostIdentityHealth; hasToken: boolean }
  | { type: "authenticated"; health?: HostIdentityHealth }
  | { type: "invalid-session"; health: HostIdentityHealth }
  | { type: "failed"; message: string };

export function shouldBypassIdentity(shellKind: "desktop" | "mobile" | "web", isLocal: boolean) {
  return shellKind === "desktop" && isLocal;
}

export function identityGateReducer(
  _state: IdentityGateState,
  action: IdentityGateAction,
): IdentityGateState {
  switch (action.type) {
    case "check":
      return { status: "checking" };
    case "health":
      if (!action.health.authRequired) return { status: "authenticated", health: action.health };
      if (action.health.identity === "setup") return { status: "setup", health: action.health };
      return action.hasToken ? { status: "checking" } : { status: "login", health: action.health };
    case "authenticated":
      return { status: "authenticated", health: action.health };
    case "invalid-session":
      return { status: "login", health: action.health };
    case "failed":
      return { status: "error", message: action.message };
  }
}
