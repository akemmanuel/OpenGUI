import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { OPENCODE_GO_PRESET } from "@opengui/protocol";
import { Button } from "@/components/ui/button";
import { createHostClient } from "@/protocol/host-client";
import type {
  CodexAuthStatus,
  HostModelConnection,
  SubscriptionProvider,
} from "@/protocol/host-types";
import { useActions } from "@/hooks/use-agent-state";
import { notifyUnknownError } from "@/lib/notify";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIdentityActor } from "@/features/identity/identity-actor-context";
import { createIdentityClient, type ModelEntitlement } from "@/features/identity/identity-client";
import { getIdentityWorkspace } from "@/features/identity/workspace-identity";
import { Switch } from "@/components/ui/switch";

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

export function SettingsProviders() {
  const { t } = useTranslation();
  const { refreshProviders } = useActions();
  const actor = useIdentityActor();
  const workspace = useMemo(() => getIdentityWorkspace(), []);
  const identity = useMemo(
    () =>
      workspace?.authToken
        ? createIdentityClient({ baseUrl: workspace.serverUrl, token: workspace.authToken })
        : null,
    [workspace],
  );
  const host = useMemo(() => {
    const electron = window.electronAPI;
    return createHostClient({
      resolveBaseUrl: () => electron?.backendUrl || workspace?.serverUrl || window.location.origin,
      resolveToken: () => electron?.backendToken || workspace?.authToken || "",
    });
  }, [workspace]);
  const [connections, setConnections] = useState<HostModelConnection[]>([]);
  const [entitlements, setEntitlements] = useState<Record<string, ModelEntitlement[]>>({});
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [zenApiKey, setZenApiKey] = useState("");
  const [goApiKey, setGoApiKey] = useState("");
  const [modelId, setModelId] = useState("gpt-4.1");
  const [plane, setPlane] = useState<"host" | "team" | "user">(
    actor?.type === "user" && actor.role !== "owner" ? "user" : "host",
  );
  const [codex, setCodex] = useState<CodexAuthStatus>({ connected: false, pending: null });
  const [subscriptions, setSubscriptions] = useState<Record<SubscriptionProvider, CodexAuthStatus>>(
    {
      xai: { connected: false, pending: null },
    },
  );

  const reload = async () => {
    const next = await host.listModelConnections();
    setConnections(next);
    if (identity && actor?.type === "user" && actor.role === "owner") {
      const manageable = next.filter(
        (connection) => connection.plane === "host" || connection.plane === "team",
      );
      const rows = await Promise.all(
        manageable.map(
          async (connection) =>
            [connection.id, await identity.modelEntitlements(connection.id)] as const,
        ),
      );
      setEntitlements(Object.fromEntries(rows));
    }
  };
  useEffect(() => {
    void reload().catch(notifyUnknownError);
    void host.codexAuthStatus().then(setCodex).catch(notifyUnknownError);
    for (const provider of ["xai"] as const) {
      void host
        .subscriptionAuthStatus(provider)
        .then((status) => setSubscriptions((current) => ({ ...current, [provider]: status })))
        .catch(notifyUnknownError);
    }
  }, []);

  async function toggleTeamEntitlement(connectionId: string, enabled: boolean) {
    if (!identity) return;
    const current = entitlements[connectionId] ?? [];
    const withoutTeam = current.filter(
      (item) => !(item.subjectType === "team" && item.subjectId === "host_default"),
    );
    const next = enabled
      ? [...withoutTeam, { subjectType: "team" as const, subjectId: "host_default", modelId: "*" }]
      : withoutTeam;
    try {
      const saved = await identity.replaceModelEntitlements(connectionId, next);
      setEntitlements((items) => ({ ...items, [connectionId]: saved }));
      await refreshProviders();
    } catch (error) {
      notifyUnknownError(error);
    }
  }

  async function addConnection() {
    try {
      await host.upsertModelConnection({
        id: `connection_${Date.now()}`,
        label: modelId.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        modelIds: [modelId.trim()],
        plane,
        credentialKind: "byok",
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

  async function enableGo() {
    try {
      await host.upsertModelConnection({
        id: OPENCODE_GO_PRESET.id,
        label: OPENCODE_GO_PRESET.label,
        baseUrl: OPENCODE_GO_PRESET.baseUrl,
        defaultModelId: OPENCODE_GO_PRESET.defaultModelId,
        modelIds: [...OPENCODE_GO_PRESET.modelIds],
        modelRoutes: { ...OPENCODE_GO_PRESET.modelRoutes },
        apiKey: goApiKey.trim(),
      });
      setGoApiKey("");
      await reload();
      await refreshProviders();
    } catch (error) {
      notifyUnknownError(error);
    }
  }

  const zenEnabled = connections.some((connection) => connection.id === OPENCODE_ZEN.id);
  const goEnabled = connections.some((connection) => connection.id === OPENCODE_GO_PRESET.id);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="font-medium">{t("settings.tabs.providers")}</h2>
        <p className="text-sm text-muted-foreground">{t("providers.description")}</p>
      </div>
      {actor?.type === "user" &&
        actor.role === "owner" &&
        connections.some(
          (connection) => connection.plane === "host" || connection.plane === "team",
        ) && (
          <section className="space-y-2 rounded-lg border p-3">
            <div>
              <h3 className="text-sm font-medium">{t("providers.teamAccessTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("providers.teamAccessHelp")}</p>
            </div>
            <div className="divide-y">
              {connections
                .filter((connection) => connection.plane === "host" || connection.plane === "team")
                .map((connection) => {
                  const enabled = (entitlements[connection.id] ?? []).some(
                    (item) => item.subjectType === "team" && item.subjectId === "host_default",
                  );
                  return (
                    <label
                      key={connection.id}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <span className="min-w-0 truncate text-sm">{connection.label}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {t("providers.teamAccess")}
                        <Switch
                          checked={enabled}
                          onCheckedChange={(checked) =>
                            void toggleTeamEntitlement(connection.id, checked)
                          }
                        />
                      </span>
                    </label>
                  );
                })}
            </div>
          </section>
        )}
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
        <div className="space-y-3 rounded-lg border p-3">
          <div>
            <div className="text-sm font-medium">{t("providers.opencode.title")}</div>
            <div className="text-xs text-muted-foreground">
              {t("providers.opencode.description")}
            </div>
          </div>
          <input
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={goApiKey}
            onChange={(event) => setGoApiKey(event.target.value)}
            type="password"
            placeholder={t("providers.opencode.apiKeyPlaceholder")}
          />
          <div className="flex gap-2">
            <Button type="button" disabled={!goApiKey.trim()} onClick={() => void enableGo()}>
              {goEnabled ? t("providers.opencode.saveKey") : t("providers.opencode.enable")}
            </Button>
            {goEnabled && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void host
                    .removeModelConnection(OPENCODE_GO_PRESET.id)
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
        {(["xai"] as const).map((provider) => {
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
                <div className="flex items-center gap-2">
                  <div className="truncate text-sm font-medium">{connection.label}</div>
                  {connection.plane && (
                    <Badge variant="outline">{t(`providers.planes.${connection.plane}`)}</Badge>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {connection.baseUrl} · {connection.modelIds.join(", ")}
                </div>
              </div>
              {(actor?.type !== "user" ||
                actor.role === "owner" ||
                (connection.plane === "user" && connection.ownerId === actor.id)) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("providers.removeConnection", { name: connection.label })}
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
              )}
            </div>
          ))}
      </div>
      <div className="space-y-3 rounded-lg border p-3">
        <div className="space-y-2">
          <Label htmlFor="provider-plane">{t("providers.connectionPlane")}</Label>
          <Select value={plane} onValueChange={(value) => setPlane(value as typeof plane)}>
            <SelectTrigger id="provider-plane">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {actor?.type !== "user" || actor.role === "owner" ? (
                <>
                  <SelectItem value="host">{t("providers.planes.host")}</SelectItem>
                  <SelectItem value="team">{t("providers.planes.team")}</SelectItem>
                </>
              ) : null}
              <SelectItem value="user">{t("providers.planes.user")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t(`providers.planeHelp.${plane}`)}</p>
        </div>
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
