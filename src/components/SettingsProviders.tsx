import {
  ArrowRight,
  Database,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { OPENCODE_GO_PRESET, XAI_API_PRESET } from "@opengui/protocol";
import { Button } from "@/components/ui/button";
import { createHostClient } from "@/protocol/host-client";
import type {
  CodexAuthStatus,
  HostModelConnection,
  HostModelOffering,
  SubscriptionProvider,
} from "@/protocol/host-types";
import { useActions } from "@/hooks/use-agent-state";
import { notifyUnknownError } from "@/lib/notify";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIdentityActor } from "@/features/identity/identity-actor-context";
import {
  createIdentityClient,
  type ModelOfferingEntitlement,
  type ModelPolicy,
  type TeamMember,
} from "@/features/identity/identity-client";
import { getIdentityWorkspace } from "@/features/identity/workspace-identity";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { CustomBackendEditor } from "@/features/model-access/CustomBackendEditor";
import {
  buildCustomModelConnection,
  createCustomBackendDraft,
  editCustomBackendDraft,
  type CustomBackendDraft,
} from "@/features/model-access/custom-backend";

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
  const [offerings, setOfferings] = useState<HostModelOffering[]>([]);
  const [offeringEntitlements, setOfferingEntitlements] = useState<
    Record<string, ModelOfferingEntitlement[]>
  >({});
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [zenApiKey, setZenApiKey] = useState("");
  const [goApiKey, setGoApiKey] = useState("");
  const [xaiApiKey, setXaiApiKey] = useState("");
  const [offeringName, setOfferingName] = useState("");
  const [offeringSlug, setOfferingSlug] = useState("");
  const [offeringBackendId, setOfferingBackendId] = useState("");
  const [offeringModelId, setOfferingModelId] = useState("");
  const [editingOfferingId, setEditingOfferingId] = useState<string | null>(null);
  const [plane, setPlane] = useState<"host" | "team" | "user">(
    actor?.type === "user" && actor.role !== "owner" && actor.role !== "admin" ? "user" : "host",
  );
  const [backendDraft, setBackendDraft] = useState<CustomBackendDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [savingBackend, setSavingBackend] = useState(false);
  const [modelPolicy, setModelPolicy] = useState<ModelPolicy | null>(null);
  const [codex, setCodex] = useState<CodexAuthStatus>({ connected: false, pending: null });
  const [subscriptions, setSubscriptions] = useState<Record<SubscriptionProvider, CodexAuthStatus>>(
    {
      xai: { connected: false, pending: null },
    },
  );
  const canManageShared =
    actor?.type !== "user" || actor.role === "owner" || actor.role === "admin";
  const personalByokAllowed =
    !identity ||
    canManageShared ||
    Boolean(modelPolicy?.host.allowByok && modelPolicy.team.allowByok);

  const reload = async () => {
    setLoadError(false);
    try {
      const next = await host.listModelConnections();
      setConnections(next);
      const nextOfferings = (await host.listModelOfferings?.()) ?? [];
      setOfferings(nextOfferings);
      if (identity && actor?.type === "user") setModelPolicy(await identity.modelPolicy());
      if (
        identity &&
        actor?.type === "user" &&
        (actor.role === "owner" || actor.role === "admin")
      ) {
        const [principals, offeringRows] = await Promise.all([
          identity.members(),
          Promise.all(
            nextOfferings.map(
              async (offering) =>
                [offering.id, await identity.modelOfferingEntitlements(offering.id)] as const,
            ),
          ),
        ]);
        setMembers(principals);
        setOfferingEntitlements(Object.fromEntries(offeringRows));
      }
    } catch (error) {
      setLoadError(true);
      throw error;
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void reload().catch(notifyUnknownError);
    if (canManageShared) {
      void host.codexAuthStatus().then(setCodex).catch(notifyUnknownError);
      for (const provider of ["xai"] as const) {
        void host
          .subscriptionAuthStatus(provider)
          .then((status) => setSubscriptions((current) => ({ ...current, [provider]: status })))
          .catch(notifyUnknownError);
      }
    }
  }, []);

  async function saveConnection() {
    if (!backendDraft) return;
    const connection = buildCustomModelConnection(backendDraft);
    if (!connection) return;
    setSavingBackend(true);
    try {
      await host.upsertModelConnection(connection);
      setBackendDraft(null);
      await reload();
      await refreshProviders();
    } catch (error) {
      notifyUnknownError(error);
    } finally {
      setSavingBackend(false);
    }
  }

  async function saveOffering() {
    if (!identity) return;
    try {
      const input = {
        displayName: offeringName,
        backendId: offeringBackendId,
        upstreamModelId: offeringModelId,
      };
      if (editingOfferingId) await identity.updateModelOffering(editingOfferingId, input);
      else await identity.createModelOffering({ id: offeringSlug, ...input });
      setOfferingName("");
      setOfferingSlug("");
      setOfferingModelId("");
      setOfferingBackendId("");
      setEditingOfferingId(null);
      await reload();
      await refreshProviders();
    } catch (error) {
      notifyUnknownError(error);
    }
  }

  async function toggleOfferingAccess(
    offeringId: string,
    subjectType: "user" | "team",
    subjectId: string,
    enabled: boolean,
  ) {
    if (!identity) return;
    const current = offeringEntitlements[offeringId] ?? [];
    const without = current.filter(
      (item) => !(item.subjectType === subjectType && item.subjectId === subjectId),
    );
    const next = enabled ? [...without, { offeringId, subjectType, subjectId }] : without;
    try {
      const saved = await identity.replaceModelOfferingEntitlements(offeringId, next);
      setOfferingEntitlements((rows) => ({ ...rows, [offeringId]: saved }));
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

  async function enableXaiApi() {
    try {
      await host.upsertModelConnection({
        ...XAI_API_PRESET,
        modelIds: [...XAI_API_PRESET.modelIds],
        modelRoutes: { ...XAI_API_PRESET.modelRoutes },
        modelCapabilities: { ...XAI_API_PRESET.modelCapabilities },
        apiKey: xaiApiKey.trim(),
      });
      setXaiApiKey("");
      await reload();
      await refreshProviders();
    } catch (error) {
      notifyUnknownError(error);
    }
  }

  const zenEnabled = connections.some((connection) => connection.id === OPENCODE_ZEN.id);
  const goEnabled = connections.some((connection) => connection.id === OPENCODE_GO_PRESET.id);
  const xaiApiEnabled = connections.some((connection) => connection.id === XAI_API_PRESET.id);
  const customConnections = connections.filter(
    (connection) =>
      !["chatgpt-codex", "supergrok", "opencode-go", "xai-api", OPENCODE_ZEN.id].includes(
        connection.id,
      ) &&
      (canManageShared || connection.plane === "user"),
  );

  if (loading)
    return (
      <div className="space-y-3" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  if (loadError)
    return (
      <div
        role="alert"
        className="space-y-3 rounded-lg bg-destructive/10 p-4 text-sm text-destructive"
      >
        <p>{t("providers.loadFailed")}</p>
        <Button variant="outline" size="sm" onClick={() => void reload().catch(notifyUnknownError)}>
          <RefreshCw />
          {t("identity.retry")}
        </Button>
      </div>
    );

  return (
    <div className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
      <div className="space-y-1">
        <h2 className="font-medium">{t("settings.tabs.providers")}</h2>
        <p className="text-sm text-muted-foreground">{t("providers.description")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1 border-b pb-3 sm:border-b-0 sm:border-r sm:pr-3">
          <Database className="size-4 text-muted-foreground" />
          <p className="text-sm font-medium">{t("providers.backendConcept")}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("providers.backendConceptHelp")}
          </p>
        </div>
        <div className="space-y-1 border-b pb-3 sm:border-b-0 sm:border-r sm:pr-3">
          <Share2 className="size-4 text-muted-foreground" />
          <p className="text-sm font-medium">{t("providers.offeringConcept")}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("providers.offeringConceptHelp")}
          </p>
        </div>
        <div className="space-y-1">
          <KeyRound className="size-4 text-muted-foreground" />
          <p className="text-sm font-medium">{t("providers.credentialsConcept")}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("providers.credentialsConceptHelp")}
          </p>
        </div>
      </div>
      {identity && actor?.type === "user" && (actor.role === "owner" || actor.role === "admin") && (
        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="font-medium">{t("providers.offeringsTitle")}</h3>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("providers.offeringsHelp")}
            </p>
          </div>
          <div className="divide-y rounded-lg border">
            {offerings.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                {t("providers.noOfferings")}
              </p>
            )}
            {offerings.map((offering) => {
              const grants = offeringEntitlements[offering.id] ?? [];
              const teamEnabled = grants.some(
                (grant) => grant.subjectType === "team" && grant.subjectId === "host_default",
              );
              return (
                <div key={offering.id} className="space-y-3 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">{offering.displayName}</p>
                      <p className="flex min-w-0 flex-wrap items-center gap-1 break-all text-xs text-muted-foreground">
                        <code>{offering.id}</code>
                        <ArrowRight className="size-3" />
                        <span>
                          {connections.find((item) => item.id === offering.backendId)?.label}
                        </span>
                        <span aria-hidden="true">/</span>
                        <code>{offering.upstreamModelId}</code>
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("providers.editOffering", { name: offering.displayName })}
                      onClick={() => {
                        setEditingOfferingId(offering.id);
                        setOfferingName(offering.displayName);
                        setOfferingSlug(offering.id);
                        setOfferingBackendId(offering.backendId ?? "");
                        setOfferingModelId(offering.upstreamModelId ?? "");
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("providers.removeOffering", { name: offering.displayName })}
                      onClick={() =>
                        void identity
                          .removeModelOffering(offering.id)
                          .then(reload)
                          .then(refreshProviders)
                          .catch(notifyUnknownError)
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    <label className="flex items-center gap-2 text-xs">
                      <Switch
                        checked={teamEnabled}
                        onCheckedChange={(checked) =>
                          void toggleOfferingAccess(offering.id, "team", "host_default", checked)
                        }
                      />
                      {t("providers.everyone")}
                    </label>
                    {!teamEnabled &&
                      members
                        .filter((member) => member.role !== "owner")
                        .map((member) => (
                          <label key={member.id} className="flex items-center gap-2 text-xs">
                            <Switch
                              checked={grants.some(
                                (grant) =>
                                  grant.subjectType === "user" && grant.subjectId === member.id,
                              )}
                              onCheckedChange={(checked) =>
                                void toggleOfferingAccess(offering.id, "user", member.id, checked)
                              }
                            />
                            {member.username}
                          </label>
                        ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="grid min-w-0 gap-2 rounded-lg bg-muted/40 p-3 sm:grid-cols-2 [&>*]:min-w-0">
            <input
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={offeringName}
              onChange={(event) => {
                setOfferingName(event.target.value);
                if (!offeringSlug)
                  setOfferingSlug(
                    event.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/gu, "-")
                      .replace(/^-+|-+$/gu, ""),
                  );
              }}
              placeholder={t("providers.offeringNamePlaceholder")}
            />
            <input
              className="rounded-md border bg-background px-3 py-2 font-mono text-sm"
              value={offeringSlug}
              onChange={(event) => setOfferingSlug(event.target.value)}
              disabled={!!editingOfferingId}
              placeholder={t("providers.offeringSlugPlaceholder")}
            />
            <Select value={offeringBackendId} onValueChange={setOfferingBackendId}>
              <SelectTrigger className="w-full min-w-0">
                <SelectValue
                  placeholder={t("providers.chooseBackend")}
                  data-responsive-allow="text-clip"
                />
              </SelectTrigger>
              <SelectContent>
                {connections
                  .filter((connection) => connection.plane !== "user")
                  .map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <input
              className="rounded-md border bg-background px-3 py-2 font-mono text-sm"
              value={offeringModelId}
              onChange={(event) => setOfferingModelId(event.target.value)}
              placeholder={t("providers.upstreamModelPlaceholder")}
            />
            <Button
              type="button"
              className="sm:col-span-2 sm:w-fit"
              disabled={
                !offeringName.trim() ||
                !offeringSlug.trim() ||
                !offeringBackendId ||
                !offeringModelId.trim()
              }
              onClick={() => void saveOffering()}
            >
              <Plus />
              {t(editingOfferingId ? "providers.saveOffering" : "providers.addOffering")}
            </Button>
            {editingOfferingId && (
              <Button
                type="button"
                variant="ghost"
                className="sm:w-fit"
                onClick={() => {
                  setEditingOfferingId(null);
                  setOfferingName("");
                  setOfferingSlug("");
                  setOfferingBackendId("");
                  setOfferingModelId("");
                }}
              >
                {t("common.cancel")}
              </Button>
            )}
          </div>
        </section>
      )}
      <div className="space-y-2">
        <div hidden={!canManageShared} className="space-y-3 rounded-lg border p-3">
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
        <div hidden={!canManageShared} className="space-y-3 rounded-lg border p-3">
          <div>
            <div className="text-sm font-medium">{t("providers.xaiApi.title")}</div>
            <div className="text-xs text-muted-foreground">{t("providers.xaiApi.description")}</div>
          </div>
          <input
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={xaiApiKey}
            onChange={(event) => setXaiApiKey(event.target.value)}
            type="password"
            placeholder={t("providers.xaiApi.apiKeyPlaceholder")}
          />
          <div className="flex gap-2">
            <Button type="button" disabled={!xaiApiKey.trim()} onClick={() => void enableXaiApi()}>
              {xaiApiEnabled ? t("providers.xaiApi.saveKey") : t("providers.xaiApi.enable")}
            </Button>
            {xaiApiEnabled && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void host
                    .removeModelConnection(XAI_API_PRESET.id)
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
        <div hidden={!canManageShared} className="space-y-3 rounded-lg border p-3">
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
        <div hidden={!canManageShared} className="space-y-3 rounded-lg border p-3">
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
          if (!canManageShared) return null;
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
        {customConnections.map((connection) => (
          <div key={connection.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
            <div className="min-w-0 flex-1 overflow-hidden" data-responsive-allow="text-clip">
              <div
                className="flex min-w-0 items-center gap-2 overflow-hidden"
                data-responsive-allow="text-clip"
              >
                <div
                  className="truncate text-sm font-medium"
                  title={connection.label}
                  data-responsive-allow="text-clip"
                >
                  {connection.label}
                </div>
                {connection.plane && (
                  <Badge variant="outline">{t(`providers.planes.${connection.plane}`)}</Badge>
                )}
              </div>
              <div
                className="truncate text-xs text-muted-foreground"
                title={`${connection.baseUrl} · ${connection.modelIds.join(", ")}`}
                data-responsive-allow="text-clip"
              >
                {connection.baseUrl} · {connection.modelIds.join(", ")}
              </div>
            </div>
            {(actor?.type !== "user" ||
              actor.role === "owner" ||
              actor.role === "admin" ||
              (connection.plane === "user" && connection.ownerId === actor.id)) && (
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("providers.editConnection", { name: connection.label })}
                  onClick={() => {
                    setPlane(connection.plane ?? "host");
                    setBackendDraft(editCustomBackendDraft(connection));
                  }}
                >
                  <Pencil />
                </Button>
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
              </div>
            )}
          </div>
        ))}
        {customConnections.length === 0 && (
          <p className="rounded-lg bg-muted/40 px-3 py-4 text-sm text-muted-foreground">
            {t("providers.noCustomBackends")}
          </p>
        )}
      </div>
      {personalByokAllowed && (
        <div className="space-y-3 border-t pt-5">
          <div>
            <h3 className="font-medium">{t("providers.customBackendTitle")}</h3>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("providers.customBackendHelp")}
            </p>
          </div>
          {backendDraft ? (
            <CustomBackendEditor
              draft={backendDraft}
              actor={actor}
              saving={savingBackend}
              onChange={setBackendDraft}
              onCancel={() => setBackendDraft(null)}
              onSave={() => void saveConnection()}
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => setBackendDraft(createCustomBackendDraft(plane))}
            >
              <Plus />
              {t("providers.addBackend")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
