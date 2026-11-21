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
const INITIAL_PROVIDER_ROWS = 8;
const DEFAULT_PROVIDER_ORDER = ["openai", "anthropic", "google"];

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
  setupMode = false,
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
  setupMode?: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [login, setLogin] = useState<ActiveLogin | null>(null);
  const [showAllProviders, setShowAllProviders] = useState(false);
  const connected = providers.filter((provider) => provider.connection);
  const available = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = providers.filter(
      (provider) =>
        !provider.connection &&
        (!needle ||
          provider.name.toLowerCase().includes(needle) ||
          provider.id.toLowerCase().includes(needle)),
    );
    if (needle) return matches;
    const ordered = [
      ...DEFAULT_PROVIDER_ORDER.flatMap((id) => matches.filter((provider) => provider.id === id)),
      ...matches.filter((provider) => !DEFAULT_PROVIDER_ORDER.includes(provider.id)),
    ];
    return setupMode && allowSubscriptions
      ? ordered.toSorted(
          (a, b) => Number(!!b.oauth?.subscription) - Number(!!a.oauth?.subscription),
        )
      : ordered;
  }, [allowSubscriptions, providers, query, setupMode]);
  const rowLimit = setupMode ? 3 : INITIAL_PROVIDER_ROWS;
  const limited = !query.trim() && !showAllProviders && available.length > rowLimit;
  const shownProviders = limited ? available.slice(0, rowLimit) : available;

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
    const oauthLabel = t(
      provider.id === "claude-code"
        ? "providers.directory.claudeCodeSignIn"
        : provider.oauth?.subscription
          ? "providers.directory.subscription"
          : "providers.directory.signIn",
    );
    const keyLabel = t(
      provider.id === KEYLESS_PROVIDER_ID
        ? "providers.directory.apiKeyOrFree"
        : "providers.directory.apiKey",
    );
    return (
      <div className="flex shrink-0 flex-wrap justify-end gap-1 max-sm:basis-full max-sm:justify-start min-[360px]:max-sm:pl-7">
        {allowed.oauth && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="max-sm:min-h-11 max-sm:min-w-11"
            aria-label={t("providers.directory.actionNamed", {
              action: oauthLabel,
              name: provider.name,
            })}
            onClick={() => void begin(provider, "oauth")}
          >
            <LogIn />
            {oauthLabel}
          </Button>
        )}
        {allowed.apiKey && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="max-sm:min-h-11 max-sm:min-w-11"
            aria-label={t("providers.directory.actionNamed", {
              action: keyLabel,
              name: provider.name,
            })}
            onClick={() => void begin(provider, "api_key")}
          >
            <KeyRound />
            {keyLabel}
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      {(connected.length > 0 || !(allowApiKeys || allowSubscriptions)) && (
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
      )}

      {(allowApiKeys || allowSubscriptions) && (
        <section className="space-y-3">
          {setupMode ? (
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("providers.directory.addTitle")}
            </h1>
          ) : (
            <h3 className="font-medium">{t("providers.directory.addTitle")}</h3>
          )}
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
          <div className="divide-y rounded-lg border bg-card">
            {available.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                {t("providers.noProvidersFound", { query: query.trim() })}
              </p>
            )}
            {shownProviders.map((provider) => (
              <div
                key={provider.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
              >
                <ProviderIcon provider={provider.id} className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={provider.name}>
                  {provider.name}
                </span>
                {signInButtons(provider)}
              </div>
            ))}
          </div>
          {limited && (
            <Button variant="outline" onClick={() => setShowAllProviders(true)}>
              {t("providers.directory.showAll", { count: available.length })}
            </Button>
          )}
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
