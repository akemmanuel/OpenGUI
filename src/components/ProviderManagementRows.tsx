import { Loader2, Plus, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "@/components/provider-icons/ProviderIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AllProvidersData } from "@/types/electron";

export function SourceBadge({ source }: { source: string }) {
  if (source === "custom") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
        custom
      </Badge>
    );
  }
  if (source === "env" || source === "api" || source === "config" || source === "subscription") {
    return (
      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
        {source === "api" ? "api key" : source === "subscription" ? "subscription" : source}
      </Badge>
    );
  }
  return null;
}

export function getProviderBadgeSource(
  allProviders: AllProvidersData,
  provider: { id: string; source: string },
): string {
  return allProviders.authKindByProvider?.[provider.id] ?? provider.source;
}

export function ProviderRow({
  provider,
  connected = false,
  showSource = false,
  badgeSource,
  disconnecting = false,
  confirming = false,
  onConnect,
  onAskDisconnect,
  onCancelDisconnect,
  onDisconnect,
}: {
  provider: { id: string; name?: string; source?: string };
  connected?: boolean;
  showSource?: boolean;
  badgeSource?: string;
  disconnecting?: boolean;
  confirming?: boolean;
  onConnect?: () => void;
  onAskDisconnect?: () => void;
  onCancelDisconnect?: () => void;
  onDisconnect?: () => void;
}) {
  const { t } = useTranslation();
  const name = provider.name || provider.id;
  const isEnv = provider.source === "env";

  return (
    <div className="flex items-center gap-3 rounded-lg border p-3 bg-card">
      <ProviderIcon provider={provider.id} className="size-5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{name}</span>
          {showSource && badgeSource ? <SourceBadge source={badgeSource} /> : null}
        </div>
      </div>
      {connected ? (
        isEnv ? (
          <span
            className="text-[11px] text-muted-foreground shrink-0"
            title={t("providers.fromEnvTitle")}
          >
            {showSource ? t("providers.fromEnv") : "from env"}
          </span>
        ) : confirming ? (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-xs text-muted-foreground mr-1">
              {t("providers.disconnectConfirm", { name })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onCancelDisconnect}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-destructive"
              disabled={disconnecting}
              onClick={onDisconnect}
              aria-label={t("providers.disconnectNamed", { name })}
            >
              {disconnecting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              <span className="ml-1">{t("providers.disconnect")}</span>
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive shrink-0"
            disabled={disconnecting}
            onClick={onAskDisconnect}
            aria-label={t("providers.disconnectNamed", { name })}
          >
            {disconnecting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Unplug className="size-3.5" />
            )}
            <span className="ml-1.5">{t("providers.disconnect")}</span>
          </Button>
        )
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={onConnect}
          aria-label={t("providers.connectNamed", { name })}
        >
          <Plus className="size-3.5 mr-1" />
          {t("providers.connect")}
        </Button>
      )}
    </div>
  );
}
