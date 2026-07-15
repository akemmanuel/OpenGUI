import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { createHostClient } from "@/protocol/host-client";
import type {
  CodexAuthStatus,
  HostModelConnection,
  SubscriptionProvider,
} from "@/protocol/host-types";
import { useActions } from "@/hooks/use-agent-state";
import { notifyUnknownError } from "@/lib/notify";

const OPENCODE_ZEN = {
  id: "opencode-zen",
  label: "OpenCode Zen",
  baseUrl: "https://opencode.ai/zen/v1",
  modelIds: [
    "big-pickle",
    "mimo-v2.5-free",
    "north-mini-code-free",
    "nemotron-3-ultra-free",
    "deepseek-v4-flash-free",
  ],
} as const;

function client() {
  const electron = window.electronAPI;
  return createHostClient({
    resolveBaseUrl: () => electron?.backendUrl || window.location.origin,
    resolveToken: () => electron?.backendToken || "",
  });
}

export function SettingsProviders() {
  const { t } = useTranslation();
  const { refreshProviders } = useActions();
  const host = useMemo(client, []);
  const [connections, setConnections] = useState<HostModelConnection[]>([]);
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [zenApiKey, setZenApiKey] = useState("");
  const [modelId, setModelId] = useState("gpt-4.1");
  const [codex, setCodex] = useState<CodexAuthStatus>({ connected: false, pending: null });
  const [subscriptions, setSubscriptions] = useState<Record<SubscriptionProvider, CodexAuthStatus>>(
    {
      xai: { connected: false, pending: null },
      opencode: { connected: false, pending: null },
    },
  );

  const reload = async () => setConnections(await host.listModelConnections());
  useEffect(() => {
    void reload().catch(notifyUnknownError);
    void host.codexAuthStatus().then(setCodex).catch(notifyUnknownError);
    for (const provider of ["xai", "opencode"] as const) {
      void host
        .subscriptionAuthStatus(provider)
        .then((status) => setSubscriptions((current) => ({ ...current, [provider]: status })))
        .catch(notifyUnknownError);
    }
  }, []);

  async function addConnection() {
    try {
      await host.upsertModelConnection({
        id: `connection_${Date.now()}`,
        label: modelId.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        modelIds: [modelId.trim()],
      });
      setApiKey("");
      await reload();
      await refreshProviders();
    } catch (error) {
      notifyUnknownError(error);
    }
  }

  async function enableZen() {
    try {
      await host.upsertModelConnection({
        ...OPENCODE_ZEN,
        modelIds: [...OPENCODE_ZEN.modelIds],
        apiKey: zenApiKey.trim() || undefined,
      });
      setZenApiKey("");
      await reload();
      await refreshProviders();
    } catch (error) {
      notifyUnknownError(error);
    }
  }

  const zenEnabled = connections.some((connection) => connection.id === OPENCODE_ZEN.id);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="font-medium">{t("settings.tabs.providers")}</h2>
        <p className="text-sm text-muted-foreground">{t("providers.description")}</p>
      </div>
      <div className="space-y-2">
        <div className="space-y-3 rounded-lg border p-3">
          <div>
            <div className="text-sm font-medium">{t("providers.zen.title")}</div>
            <div className="text-xs text-muted-foreground">{t("providers.zen.description")}</div>
          </div>
          <input
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={zenApiKey}
            onChange={(event) => setZenApiKey(event.target.value)}
            type="password"
            placeholder={t("providers.zen.apiKeyPlaceholder")}
          />
          <div className="flex gap-2">
            <Button type="button" onClick={() => void enableZen()}>
              {zenEnabled ? t("providers.zen.saveKey") : t("providers.zen.enable")}
            </Button>
            {zenEnabled && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void host
                    .removeModelConnection(OPENCODE_ZEN.id)
                    .then(reload)
                    .then(refreshProviders)
                    .catch(notifyUnknownError)
                }
              >
                {t("providers.disconnect")}
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-3 rounded-lg border p-3">
          <div>
            <div className="text-sm font-medium">{t("providers.codex.title")}</div>
            <div className="text-xs text-muted-foreground">{t("providers.codex.description")}</div>
          </div>
          {codex.pending && (
            <div className="space-y-2">
              <p className="text-sm">
                {t("providers.codex.code", { code: codex.pending.userCode })}
              </p>
              <a
                className="text-sm underline"
                href={codex.pending.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                {t("providers.codex.open")}
              </a>
              <Button
                variant="secondary"
                onClick={() =>
                  void host
                    .pollCodexAuth()
                    .then(setCodex)
                    .then(reload)
                    .then(refreshProviders)
                    .catch(notifyUnknownError)
                }
              >
                {t("providers.codex.check")}
              </Button>
            </div>
          )}
          {!codex.connected && !codex.pending && (
            <Button
              onClick={() => void host.beginCodexAuth().then(setCodex).catch(notifyUnknownError)}
            >
              {t("providers.codex.signIn")}
            </Button>
          )}
          {codex.connected && (
            <Button
              variant="outline"
              onClick={() =>
                void host
                  .disconnectCodex()
                  .then(() => setCodex({ connected: false, pending: null }))
                  .then(reload)
                  .then(refreshProviders)
                  .catch(notifyUnknownError)
              }
            >
              {t("providers.codex.signOut")}
            </Button>
          )}
        </div>
        {(["xai", "opencode"] as const).map((provider) => {
          const status = subscriptions[provider];
          return (
            <div key={provider} className="space-y-3 rounded-lg border p-3">
              <div>
                <div className="text-sm font-medium">{t(`providers.${provider}.title`)}</div>
                <div className="text-xs text-muted-foreground">
                  {t(`providers.${provider}.description`)}
                </div>
              </div>
              {status.pending && (
                <div className="space-y-2">
                  <p className="text-sm">
                    {t("providers.codex.code", { code: status.pending.userCode })}
                  </p>
                  <a
                    className="text-sm underline"
                    href={status.pending.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("providers.codex.open")}
                  </a>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void host
                        .pollSubscriptionAuth(provider)
                        .then((next) =>
                          setSubscriptions((current) => ({ ...current, [provider]: next })),
                        )
                        .then(reload)
                        .then(refreshProviders)
                        .catch(notifyUnknownError)
                    }
                  >
                    {t("providers.codex.check")}
                  </Button>
                </div>
              )}
              {!status.connected && !status.pending && (
                <Button
                  onClick={() =>
                    void host
                      .beginSubscriptionAuth(provider)
                      .then((next) =>
                        setSubscriptions((current) => ({ ...current, [provider]: next })),
                      )
                      .catch(notifyUnknownError)
                  }
                >
                  {t(`providers.${provider}.signIn`)}
                </Button>
              )}
              {status.connected && (
                <Button
                  variant="outline"
                  onClick={() =>
                    void host
                      .disconnectSubscription(provider)
                      .then(() =>
                        setSubscriptions((current) => ({
                          ...current,
                          [provider]: { connected: false, pending: null },
                        })),
                      )
                      .then(reload)
                      .then(refreshProviders)
                      .catch(notifyUnknownError)
                  }
                >
                  {t("providers.codex.signOut")}
                </Button>
              )}
            </div>
          );
        })}
        {connections
          .filter(
            (connection) =>
              connection.id !== "chatgpt-codex" &&
              connection.id !== "supergrok" &&
              connection.id !== "opencode-go" &&
              connection.id !== OPENCODE_ZEN.id,
          )
          .map((connection) => (
            <div
              key={connection.id}
              className="flex items-center gap-3 rounded-lg border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{connection.label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {connection.baseUrl} · {connection.modelIds.join(", ")}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  void host
                    .removeModelConnection(connection.id)
                    .then(reload)
                    .then(refreshProviders)
                    .catch(notifyUnknownError);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
      </div>
      <div className="space-y-3 rounded-lg border p-3">
        <input
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.openai.com/v1"
        />
        <input
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          placeholder={t("providers.apiKey")}
        />
        <input
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
          placeholder="gpt-4.1"
        />
        <Button
          type="button"
          disabled={!baseUrl.trim() || !modelId.trim()}
          onClick={() => void addConnection()}
        >
          <Plus className="size-4" />
          {t("providers.addProvider")}
        </Button>
      </div>
    </div>
  );
}
