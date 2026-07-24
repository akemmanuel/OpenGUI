import { createContext, type ReactNode, useContext } from "react";
import type { ActorSnapshot } from "@/protocol/host-types";
import type { IdentityActor } from "./identity-client";

export const DESKTOP_LOCAL_ACTOR: IdentityActor = {
  type: "local",
  id: "desktop-local",
  displayName: "",
  role: "owner",
};

const IdentityActorContext = createContext<IdentityActor | null>(null);

export function IdentityActorProvider({
  actor,
  children,
}: {
  actor: IdentityActor | null;
  children: ReactNode;
}) {
  return <IdentityActorContext.Provider value={actor}>{children}</IdentityActorContext.Provider>;
}

export function useIdentityActor(): IdentityActor | null {
  return useContext(IdentityActorContext);
}

export function snapshotIdentityActor(actor: IdentityActor | null): ActorSnapshot | undefined {
  if (!actor) return undefined;
  return { type: actor.type, id: actor.id, displayName: actor.displayName };
}
