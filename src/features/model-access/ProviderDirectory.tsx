import { KeyRound, LogIn, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProviderLoginDialog } from "@/components/ProviderLoginDialog";
import { ProviderIcon } from "@/components/provider-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { notifyUnknownError } from "@/lib/notify";
import type {
  HostProviderInfo,
  OpenGuiHostClient,
  ProviderAuthMethod,
  ProviderLoginStatus,
} from "@/protocol/host-types";

/** OpenCode Zen serves its free models without an API key. */
const KEYLESS_PROVIDER_ID = "opencode";

type ActiveLogin = {
  provider: HostProviderInfo;
  method: ProviderAuthMethod;
  status: ProviderLoginStatus | null;
};

export function ProviderDirectory({
  host,
  providers,
  canManageShared,
  allowApiKeys,
  allowSubscriptions,
  showScope,
  onChanged,
}: {
  host: Pick<
    OpenGuiHostClient,
    | "beginProviderLogin"
    | "providerLoginStatus"
    | "respondProviderLogin"
    | "cancelProviderLogin"
    | "disconnectProvider"
  >;
  providers: HostProviderInfo[];
  canManageShared: boolean;
  allowApiKeys: boolean;
  allowSubscriptions: boolean;
  /** Label connections as Host or Personal (multi-user Hosts only). */
  showScope: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [login, setLogin] = useState<ActiveLogin | null>(null);
  const connected = providers.filter((provider) => provider.connection);
  const available = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return providers.filter(
      (provider) =>
        !provider.connection &&
        (!needle ||
          provider.name.toLowerCase().includes(needle) ||
          provider.id.toLowerCase().includes(needle)),
    );
  }, [providers, query]);

  const methods = (provider: HostProviderInfo) => ({
    apiKey: Boolean(provider.apiKey?.interactive) && allowApiKeys,
    oauth: Boolean(provider.oauth) && allowSubscriptions,
  });

  async function begin(provider: HostProviderInfo, method: ProviderAuthMethod) {
    setLogin({ provider, method, status: null });
    try {
      const status = await host.beginProviderLogin(provider.id, method);
      setLogin({ provider, method, status });
    } catch (error) {
      setLogin(null);
      notifyUnknownError(error);
    }
  }

  async function disconnect(provider: HostProviderInfo) {
    try {
      await host.disconnectProvider(provider.id);
      await onChanged();
    } catch (error) {
      notifyUnknownError(error);
    }
  }

  const signInButtons = (provider: HostProviderInfo) => {
    const allowed = methods(provider);
    return (
      <div className="flex shrink-0 flex-wrap justify-end gap-1">
        {allowed.oauth && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t("providers.directory.signInNamed", { name: provider.name })}
            onClick={() => void begin(provider, "oauth")}
          >
            <LogIn />
            {provider.oauth?.subscription
              ? t("providers.directory.subscription")
              : t("providers.directory.signIn")}
          </Button>
        )}
        {allowed.apiKey && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t("providers.directory.apiKeyNamed", { name: provider.name })}
            onClick={() => void begin(provider, "api_key")}
          >
            <KeyRound />
            {provider.id === KEYLESS_PROVIDER_ID
              ? t("providers.directory.apiKeyOrFree")
              : t("providers.directory.apiKey")}
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h3 className="font-medium">{t("providers.directory.connectedTitle")}</h3>
        {connected.length === 0 ? (
          <p className="rounded-lg bg-muted/40 px-3 py-4 text-sm text-muted-foreground">
            {t("providers.directory.connectedEmpty")}
          </p>
        ) : (
          <div className="divide-y rounded-lg border">
            {connected.map((provider) => {
              const connection = provider.connection!;
              return (
                <div key={provider.id} className="flex items-center gap-3 px-3 py-2">
                  <ProviderIcon provider={provider.id} className="size-4 shrink-0" />
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium" title={provider.name}>
                      {provider.name}
                    </span>
                    <Badge variant="outline">
                      {connection.authType === "oauth"
                        ? t("providers.directory.authOAuth")
                        : t("providers.directory.authApiKey")}
                    </Badge>
                    {showScope && (
                      <Badge variant="outline">
                        {t(`providers.planes.${connection.personal ? "user" : "host"}`)}
                      </Badge>
                    )}
                  </div>
                  {(canManageShared || connection.personal) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={t("providers.disconnectNamed", { name: provider.name })}
                      onClick={() => void disconnect(provider)}
                    >
                      {t("providers.disconnect")}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {(allowApiKeys || allowSubscriptions) && (
        <section className="space-y-3">
          <div>
            <h3 className="font-medium">{t("providers.directory.addTitle")}</h3>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("providers.directory.addHelp")}
            </p>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("providers.searchPlaceholder")}
              placeholder={t("providers.searchPlaceholder")}
            />
          </div>
          <div className="max-h-96 divide-y overflow-y-auto rounded-lg border">
            {available.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                {t("providers.noProvidersFound", { query: query.trim() })}
              </p>
            )}
            {available.map((provider) => (
              <div key={provider.id} className="flex items-center gap-3 px-3 py-2">
                <ProviderIcon provider={provider.id} className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm" title={provider.name}>
                  {provider.name}
                </span>
                {signInButtons(provider)}
              </div>
            ))}
          </div>
        </section>
      )}

      <ProviderLoginDialog
        open={login !== null}
        providerName={login?.provider.name ?? ""}
        status={login?.status ?? null}
        allowEmptySecret={login?.provider.id === KEYLESS_PROVIDER_ID && login.method === "api_key"}
        emptySecretHint={t("providers.directory.freeTierHint")}
        onPoll={() => host.providerLoginStatus(login!.provider.id)}
        onRespond={(promptId, value) =>
          host.respondProviderLogin(login!.provider.id, promptId, value)
        }
        onCancel={() => host.cancelProviderLogin(login!.provider.id)}
        onRetry={() => (login ? begin(login.provider, login.method) : undefined)}
        onClose={() => setLogin(null)}
        onSuccess={() => void onChanged().catch(notifyUnknownError)}
      />
    </div>
  );
}
