import { ProviderIcon } from "@/components/provider-icons";
import { DurationLabel } from "./DurationLabel";
import type { TurnFooter } from "./types";

export function AssistantTurnFooter({ footer }: { footer: TurnFooter }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
      <DurationLabel footer={footer} />
      {footer.providerID && (
        <ProviderIcon provider={footer.providerID} className="size-3 shrink-0 opacity-60" />
      )}
      {footer.modelID && (
        <span className="min-w-0 truncate opacity-60" data-responsive-allow="text-clip">
          {footer.modelID}
        </span>
      )}
      {footer.thinkingLevel && <span className="opacity-40">{footer.thinkingLevel}</span>}
    </div>
  );
}
