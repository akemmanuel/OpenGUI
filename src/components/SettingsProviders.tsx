import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { createHostClient } from "@/protocol/host-client";
import type {
  HostModelConnection,
  HostModelOffering,
  HostProviderInfo,
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
  type HostTeam,
  type ModelPolicy,
  type TeamMember,
} from "@/features/identity/identity-client";
import { getIdentityWorkspace } from "@/features/identity/workspace-identity";
import { ModelAccessEditor } from "@/features/model-access/ModelAccessEditor";
import { Skeleton } from "@/components/ui/skeleton";
import { CustomBackendEditor } from "@/features/model-access/CustomBackendEditor";
import { ProviderDirectory } from "@/features/model-access/ProviderDirectory";
import {
  buildCustomModelConnection,
  createCustomBackendDraft,
  editCustomBackendDraft,
  type CustomBackendDraft,
} from "@/features/model-access/custom-backend";

export function SettingsProviders({
  onDirtyChange,
}: { onDirtyChange?: (dirty: boolean) => void } = {}) {
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
  const [providers, setProviders] = useState<HostProviderInfo[]>([]);
  const [offerings, setOfferings] = useState<HostModelOffering[]>([]);
  const [offeringEntitlements, setOfferingEntitlements] = useState<
    Record<string, ModelOfferingEntitlement[]>
  >({});
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [teams, setTeams] = useState<HostTeam[]>([]);
  const [accessId, setAccessId] = useState<string | null>(null);
  const [accessDirty, setAccessDirty] = useState(false);
  useEffect(() => {
    onDirtyChange?.(accessDirty);
    return () => onDirtyChange?.(false);
  }, [accessDirty, onDirtyChange]);
  const [showConnections, setShowConnections] = useState(false);
  const [showOfferingForm, setShowOfferingForm] = useState(false);
  const [savingOffering, setSavingOffering] = useState(false);
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
  const canManageShared =
    actor?.type !== "user" || actor.role === "owner" || actor.role === "admin";
  const personalByokAllowed =
    !identity ||
    canManageShared ||
    Boolean(
      modelPolicy?.effective?.allowByok ??
      (modelPolicy?.host.allowByok && modelPolicy.team.allowByok),
    );
  const personalByosAllowed =
    !identity ||
    canManageShared ||
    Boolean(
      modelPolicy?.effective?.allowByos ??
      (modelPolicy?.host.allowByos && modelPolicy.team.allowByos),
    );
  const reload = async () => {
    setLoadError(false);
    try {
      const [next, nextProviders] = await Promise.all([
        host.listModelConnections(),
        host.listProviders(),
      ]);
      setConnections(next);
      setProviders(nextProviders);
      const nextOfferings = (await host.listModelOfferings?.()) ?? [];
      setOfferings(nextOfferings);
      if (identity && actor?.type === "user") setModelPolicy(await identity.modelPolicy());
      if (
        identity &&
        actor?.type === "user" &&
        (actor.role === "owner" || actor.role === "admin")
      ) {
        const [principals, offeringRows, nextTeams] = await Promise.all([
          identity.members(),
          Promise.all(
            nextOfferings.map(
              async (offering) =>
                [offering.id, await identity.modelOfferingEntitlements(offering.id)] as const,
            ),
          ),
          identity.teams(),
        ]);
        setTeams(nextTeams);
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
    if (!identity || savingOffering) return;
    setSavingOffering(true);
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
      setShowOfferingForm(false);
      await reload();
      await refreshProviders();
    } catch (error) {
      notifyUnknownError(error);
    } finally {
      setSavingOffering(false);
    }
  }

  const customConnections = connections.filter(
    (connection) => !connection.providerId && (canManageShared || connection.plane === "user"),
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
      {identity && canManageShared && (
        <div className="flex gap-2" role="group" aria-label={t("settings.tabs.models")}>
          <Button
            variant={showConnections ? "ghost" : "secondary"}
            aria-pressed={!showConnections}
            onClick={() => setShowConnections(false)}
          >
            {t("access.catalog")}
          </Button>
          <Button
            variant={showConnections ? "secondary" : "ghost"}
            disabled={accessDirty}
            aria-pressed={showConnections}
            onClick={() => setShowConnections(true)}
          >
            {t("access.connections")}
          </Button>
        </div>
      )}
      {!showConnections &&
        identity &&
        actor?.type === "user" &&
        (actor.role === "owner" || actor.role === "admin") && (
          <section className="space-y-3 border-t pt-5">
            <div className="divide-y">
              {offerings.length === 0 && (
                <p className="px-3 py-4 text-sm text-muted-foreground">
                  {t("providers.noOfferings")}
                </p>
              )}
              {offerings.map((offering) => {
                const grants = offeringEntitlements[offering.id] ?? [];
                return (
                  <div key={offering.id} className="space-y-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium">{offering.displayName}</p>
                        <p className="break-words text-xs text-muted-foreground">
                          {grants.length
                            ? grants
                                .map((grant) =>
                                  grant.subjectType === "team"
                                    ? grant.subjectId === "host_default"
                                      ? t("access.everyone")
                                      : teams.find((team) => team.id === grant.subjectId)?.name
                                    : members.find((member) => member.id === grant.subjectId)
                                        ?.username,
                                )
                                .filter(Boolean)
                                .join(" · ")
                            : t("access.adminOnly")}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={accessDirty}
                        aria-label={t("providers.editOffering", { name: offering.displayName })}
                        onClick={() => {
                          setShowOfferingForm(true);
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
                        disabled={accessDirty}
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
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={accessDirty}
                      aria-expanded={accessId === offering.id}
                      onClick={() =>
                        setAccessId((current) => (current === offering.id ? null : offering.id))
                      }
                    >
                      {t("access.manage")}
                    </Button>
                    {accessId === offering.id && (
                      <ModelAccessEditor
                        key={offering.id}
                        grants={grants}
                        onDirtyChange={setAccessDirty}
                        teams={teams}
                        members={members}
                        save={(next) =>
                          identity.replaceModelOfferingEntitlements(offering.id, next)
                        }
                        onSaved={(next) => {
                          setOfferingEntitlements((rows) => ({
                            ...rows,
                            [offering.id]: next.map((grant) => ({
                              ...grant,
                              offeringId: offering.id,
                            })),
                          }));
                          void refreshProviders().catch(notifyUnknownError);
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            {!showOfferingForm && (
              <Button onClick={() => setShowOfferingForm(true)}>
                <Plus />
                {t("providers.addOffering")}
              </Button>
            )}
            {showOfferingForm && (
              <div className="grid min-w-0 gap-3 border-t pt-4 sm:grid-cols-2 [&>*]:min-w-0">
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
                  aria-label={t("providers.offeringNamePlaceholder")}
                  placeholder={t("providers.offeringNamePlaceholder")}
                />
                <input
                  className="rounded-md border bg-background px-3 py-2 font-mono text-sm"
                  value={offeringSlug}
                  onChange={(event) => setOfferingSlug(event.target.value)}
                  disabled={!!editingOfferingId}
                  aria-label={t("providers.offeringSlugPlaceholder")}
                  placeholder={t("providers.offeringSlugPlaceholder")}
                />
                <Select value={offeringBackendId} onValueChange={setOfferingBackendId}>
                  <SelectTrigger
                    className="w-full min-w-0"
                    aria-label={t("providers.chooseBackend")}
                  >
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
                  aria-label={t("providers.upstreamModelPlaceholder")}
                  placeholder={t("providers.upstreamModelPlaceholder")}
                />
                <Button
                  type="button"
                  className="sm:col-span-2 sm:w-fit"
                  disabled={
                    savingOffering ||
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
                {
                  <Button
                    type="button"
                    variant="ghost"
                    className="sm:w-fit"
                    onClick={() => {
                      setShowOfferingForm(false);
                      setEditingOfferingId(null);
                      setOfferingName("");
                      setOfferingSlug("");
                      setOfferingBackendId("");
                      setOfferingModelId("");
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                }
              </div>
            )}
          </section>
        )}
      {(!identity || !canManageShared || showConnections) && (
        <>
          <div className="space-y-2">
            <ProviderDirectory
              host={host}
              providers={providers}
              canManageShared={canManageShared}
              allowApiKeys={personalByokAllowed}
              allowSubscriptions={personalByosAllowed}
              showScope={Boolean(identity)}
              onChanged={() => reload().then(refreshProviders)}
            />
            <h3 className="border-t pt-5 font-medium">{t("providers.customBackendsTitle")}</h3>
            {customConnections.map((connection) => (
              <div
                key={connection.id}
                className="flex items-center gap-3 rounded-lg border px-3 py-2"
              >
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
        </>
      )}
    </div>
  );
}
