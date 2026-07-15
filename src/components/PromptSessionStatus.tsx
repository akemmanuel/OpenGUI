import { PromptContextStatus } from "@/components/PromptContextStatus";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";

export function PromptSessionStatus({
  contextPercent,
  contextTokens,
  contextCost,
  contextLimit,
  isLoading,
}: {
  contextPercent: number | null;
  contextTokens: number | null;
  contextCost: number | null;
  contextLimit: number | null;
  isLoading: boolean;
}) {
  const capabilities = useBackendCapabilities();
  const canShowContext = Boolean(
    capabilities.compact && contextPercent != null && contextPercent >= 0,
  );
  if (!canShowContext) return null;
  return (
    <div className="flex items-center justify-end px-1 pb-1">
      <PromptContextStatus
        contextPercent={contextPercent!}
        contextTokens={contextTokens}
        contextCost={contextCost}
        contextLimit={contextLimit}
        isLoading={isLoading}
        isDisabled
        isCompacting={false}
        isCompactingInProgress={false}
        onCompact={() => {}}
      />
    </div>
  );
}
