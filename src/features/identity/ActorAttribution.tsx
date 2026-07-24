import type { HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import type { ActorSnapshot } from "@/protocol/host-types";
import { cn } from "@/lib/utils";
import { useIdentityActor } from "./identity-actor-context";

export function actorAttributionText(
  actor: ActorSnapshot | undefined,
  currentActor: ActorSnapshot | null,
  youLabel: string,
): string | null {
  if (!actor) return null;
  if (currentActor && actor.type === currentActor.type && actor.id === currentActor.id) {
    return youLabel;
  }
  const displayName = actor.displayName.trim();
  return displayName || null;
}

export function ActorAttributionLabel({
  actor,
  currentActor,
  youLabel,
  className,
  ...props
}: {
  actor?: ActorSnapshot;
  currentActor: ActorSnapshot | null;
  youLabel: string;
} & HTMLAttributes<HTMLSpanElement>) {
  const label = actorAttributionText(actor, currentActor, youLabel);
  if (!label) return null;
  return (
    <span className={cn("text-[11px] font-medium text-muted-foreground", className)} {...props}>
      {label}
    </span>
  );
}

export function ActorAttribution({
  actor,
  ...props
}: { actor?: ActorSnapshot } & HTMLAttributes<HTMLSpanElement>) {
  const { t } = useTranslation();
  const currentActor = useIdentityActor();
  return (
    <ActorAttributionLabel
      actor={actor}
      currentActor={currentActor}
      youLabel={t("identity.you")}
      {...props}
    />
  );
}
