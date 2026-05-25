/**
 * Provider management section for the Settings dialog.
 *
 * Shows three areas:
 * 1. Connected providers (with disconnect)
 * 2. Popular providers (quick connect)
 * 3. Custom provider + "View all" link
 */

import type { AgentBackendId } from "@/agents";
import { AGENT_BACKEND_LABELS } from "@/agents";
import { Loader2, Plus, Search, Unplug } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DialogConnectProvider } from "@/components/DialogConnectProvider";
import { DialogCustomProvider } from "@/components/DialogCustomProvider";
import { DialogSelectProvider } from "@/components/DialogSelectProvider";
import { ProviderIcon } from "@/components/provider-icons/ProviderIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAgentBackend, useCurrentAgentBackendId } from "@/hooks/use-agent-backend";
import { useActions, useConnectionState } from "@/hooks/use-agent-state";
import { useOpenGuiClient } from "@/protocol/provider";
import { POPULAR_PROVIDER_IDS } from "@/lib/constants";
import { getErrorMessage } from "@/lib/utils";
import type { AllProvidersData, ProviderAuthMethod } from "@/types/electron";

// ---------------------------------------------------------------------------
// Source badge
// ---------------------------------------------------------------------------

function SourceBadge({ source }: { source: string }) {
  if (source === "custom") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
        custom
      </Badge>
    );
  }
  if (source === "env" || source === "api" || source === "config") {
    return (
      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
        {source === "api" ? "api key" : source}
      </Badge>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SettingsProviders() {
  const { refreshProviders } = useActions();
  const { activeDirectory, activeWorkspaceId } = useConnectionState();
  const initialBackendId = useCurrentAgentBackendId();
  const [backendId, setBackendId] = useState<AgentBackendId>(initialBackendId);
  const backend = useAgentBackend(backendId);
  const providersApi = backend?.platform?.providers;
  const scopedDirectory = activeDirectory ?? undefined;

  // Data
  const [allProviders, setAllProviders] = useState<AllProvidersData | null>(null);
  const [authMethods, setAuthMethods] = useState<Record<string, ProviderAuthMethod[]>>({});
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<{
    providerID: string;
    message: string;
  } | null>(null);

  // Sub-dialog state
  const [connectProviderID, setConnectProviderID] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [showSelectAll, setShowSelectAll] = useState(false);

  // Search
  const [search, setSearch] = useState("");
  const lowerSearch = search.toLowerCase().trim();
  const isSearching = lowerSearch.length > 0;

  // Filter backends that support provider management
  const openGuiClient = useOpenGuiClient();
  const providerBackendIds = useMemo(
    () =>
      openGuiClient.agentBackends
        .list()
        .filter((b) => b.capabilities?.providerAuth)
        .map((b) => b.id as AgentBackendId),
    [openGuiClient],
  );

  // Wait for auth methods to be loaded for this provider
  const isAuthLoading =
    loading || (!connectProviderID ? false : authMethods[connectProviderID] === undefined);

  const refresh = useCallback(
    async (showSpinner = false) => {
      if (!providersApi) return;
      if (showSpinner) setLoading(true);
      try {
        const target = { directory: scopedDirectory, workspaceId: activeWorkspaceId };
        const [allProvidersData, providerAuthMethods] = await Promise.all([
          providersApi.listAll(target),
          providersApi.getAuthMethods(target),
        ]);
        setAllProviders(allProvidersData);
        setAuthMethods(providerAuthMethods);
      } finally {
        if (showSpinner) setLoading(false);
      }
    },
    [providersApi, scopedDirectory, activeWorkspaceId],
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const handleDisconnect = async (providerID: string) => {
    if (!providersApi) return;
    setConfirmingDisconnect(null);
    setDisconnectError(null);
    setDisconnecting(providerID);
    try {
      const target = { directory: scopedDirectory, workspaceId: activeWorkspaceId };
      await providersApi.disconnect(target, providerID);
      await providersApi.dispose(target);
      await refresh();
      await refreshProviders();
    } catch (err) {
      setDisconnectError({
        providerID,
        message: getErrorMessage(err, "Failed to disconnect"),
      });
    } finally {
      setDisconnecting(null);
    }
  };

  const handleConnected = async () => {
    // Called after a provider is connected (from any sub-dialog)
    setConnectProviderID(null);
    setShowCustom(false);
    setShowSelectAll(false);
    await refresh();
    await refreshProviders();
  };

  if (!providersApi) {
    return (
      <div className="text-center py-6 text-sm text-muted-foreground">
        Current backend has no provider management.
      </div>
    );
  }

  if (loading && !allProviders) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (!allProviders) {
    return (
      <div className="text-center py-6 text-sm text-muted-foreground">
        Could not load providers. Is the server connected?
      </div>
    );
  }

  const providerList = Array.isArray(allProviders.all) ? allProviders.all : [];
  const connectedIds = Array.isArray(allProviders.connected) ? allProviders.connected : [];
  const connectedSet = new Set(connectedIds);
  const connectedProviders = providerList
    .filter((p) => connectedSet.has(p.id))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  const popularNotConnected = POPULAR_PROVIDER_IDS.filter((id) => !connectedSet.has(id));
  const allById = new Map(providerList.map((p) => [p.id, p]));

  const connectProvider = connectProviderID ? allById.get(connectProviderID) : null;
  const filteredProviders = providerList
    .filter(
      (p) =>
        p.id.toLowerCase().includes(lowerSearch) ||
        (p.name || "").toLowerCase().includes(lowerSearch),
    )
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  return (
    <>
      <div className="space-y-5 max-h-[50vh] overflow-y-auto pr-1">
        {providerBackendIds.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {providerBackendIds.map((id) => (
              <Button
                key={id}
                type="button"
                variant={backendId === id ? "default" : "outline"}
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setBackendId(id)}
              >
                {AGENT_BACKEND_LABELS[id]}
              </Button>
            ))}
          </div>
        )}
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search providers..."
            className="pl-8 text-sm"
          />
        </div>
        {isSearching ? (
          <div className="space-y-1.5">
            {filteredProviders.map((provider) => {
              const isConnected = connectedSet.has(provider.id);
              const isEnv = provider.source === "env";
              const isDisconnecting = disconnecting === provider.id;
              const isConfirming = confirmingDisconnect === provider.id;
              const showError = disconnectError?.providerID === provider.id && !isDisconnecting;
              return (
                <div key={provider.id}>
                  <div className="flex items-center gap-3 rounded-lg border p-3 bg-card">
                    <ProviderIcon provider={provider.id} className="size-5 shrink-0" />
                    <span className="text-sm font-medium truncate flex-1">
                      {provider.name || provider.id}
                    </span>
                    {isConnected ? (
                      isEnv ? (
                        <span className="text-[11px] text-muted-foreground shrink-0">from env</span>
                      ) : isConfirming ? (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-xs text-muted-foreground mr-1">
                            Disconnect {provider.name || provider.id}?
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setConfirmingDisconnect(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-destructive"
                            disabled={isDisconnecting}
                            onClick={() => handleDisconnect(provider.id)}
                          >
                            {isDisconnecting ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Unplug className="size-3.5" />
                            )}
                            <span className="ml-1">Disconnect</span>
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive shrink-0"
                          disabled={isDisconnecting}
                          onClick={() => setConfirmingDisconnect(provider.id)}
                        >
                          {isDisconnecting ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Unplug className="size-3.5" />
                          )}
                          <span className="ml-1.5">Disconnect</span>
                        </Button>
                      )
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setConnectProviderID(provider.id)}
                      >
                        <Plus className="size-3.5 mr-1" />
                        Connect
                      </Button>
                    )}
                  </div>
                  {showError && (
                    <div className="flex items-center gap-2 mt-1 px-1">
                      <p className="text-xs text-destructive flex-1">{disconnectError?.message}</p>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setDisconnectError(null)}
                      >
                        dismiss
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {filteredProviders.length === 0 && (
              <div className="text-center py-6 text-sm text-muted-foreground">
                No providers found for &quot;{search}&quot;
              </div>
            )}
          </div>
        ) : (
          <>
            {connectedProviders.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Connected
                </h4>
                {connectedProviders.map((provider) => {
                  const isEnv = provider.source === "env";
                  const isDisconnecting = disconnecting === provider.id;
                  const isConfirming = confirmingDisconnect === provider.id;
                  const showError = disconnectError?.providerID === provider.id && !isDisconnecting;
                  return (
                    <div key={provider.id}>
                      <div className="flex items-center gap-3 rounded-lg border p-3 bg-card">
                        <ProviderIcon provider={provider.id} className="size-5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">
                              {provider.name || provider.id}
                            </span>
                            <SourceBadge source={provider.source} />
                          </div>
                        </div>
                        {isEnv ? (
                          <span
                            className="text-[11px] text-muted-foreground shrink-0"
                            title="Connected from your environment variables"
                          >
                            from env
                          </span>
                        ) : isConfirming ? (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-xs text-muted-foreground mr-1">
                              Disconnect {provider.name || provider.id}?
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => setConfirmingDisconnect(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-destructive"
                              disabled={isDisconnecting}
                              onClick={() => handleDisconnect(provider.id)}
                            >
                              {isDisconnecting ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Unplug className="size-3.5" />
                              )}
                              <span className="ml-1">Disconnect</span>
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive shrink-0"
                            disabled={isDisconnecting}
                            onClick={() => setConfirmingDisconnect(provider.id)}
                          >
                            {isDisconnecting ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Unplug className="size-3.5" />
                            )}
                            <span className="ml-1.5">Disconnect</span>
                          </Button>
                        )}
                      </div>
                      {showError && (
                        <div className="flex items-center gap-2 mt-1 px-1">
                          <p className="text-xs text-destructive flex-1">
                            {disconnectError?.message}
                          </p>
                          <button
                            type="button"
                            className="text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => setDisconnectError(null)}
                          >
                            dismiss
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            )}

            {/* Popular providers (not yet connected) */}
            {popularNotConnected.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Popular
                </h4>
                {popularNotConnected.map((id) => {
                  const provider = allById.get(id);
                  return (
                    <div key={id} className="flex items-center gap-3 rounded-lg border p-3 bg-card">
                      <ProviderIcon provider={id} className="size-5 shrink-0" />
                      <span className="text-sm font-medium truncate flex-1">
                        {provider?.name || id}
                      </span>
                      <Button variant="outline" size="sm" onClick={() => setConnectProviderID(id)}>
                        <Plus className="size-3.5 mr-1" />
                        Connect
                      </Button>
                    </div>
                  );
                })}
              </section>
            )}

            {/* Custom + View all */}
            <section className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Other
              </h4>
              <div
                className="flex items-center gap-3 rounded-lg border p-3 bg-card cursor-pointer hover:bg-accent transition-colors"
                onClick={() => setShowCustom(true)}
              >
                <ProviderIcon provider="synthetic" className="size-5 shrink-0" />
                <span className="text-sm font-medium truncate flex-1">Custom provider</span>
                <Button variant="outline" size="sm">
                  <Plus className="size-3.5 mr-1" />
                  Connect
                </Button>
              </div>
              <div
                className="flex items-center gap-3 rounded-lg border p-3 bg-card cursor-pointer hover:bg-accent transition-colors"
                onClick={() => setShowSelectAll(true)}
              >
                <ProviderIcon provider="synthetic" className="size-5 shrink-0" />
                <span className="text-sm font-medium truncate flex-1">All providers</span>
              </div>
            </section>
          </>
        )}
      </div>

      {/* Connect dialog */}
      <Dialog
        open={!!connectProviderID}
        onOpenChange={(open) => {
          if (!open) setConnectProviderID(null);
        }}
      >
        <DialogContent>
          <DialogTitle className="sr-only">
            Connect {connectProvider?.name ?? connectProviderID ?? ""}
          </DialogTitle>
          {connectProviderID && (
            <DialogConnectProvider
              directory={scopedDirectory}
              backendId={backendId}
              providerID={connectProviderID}
              providerName={connectProvider?.name ?? connectProviderID}
              authMethods={authMethods[connectProviderID] ?? []}
              loading={isAuthLoading}
              onConnected={handleConnected}
              onBack={() => setConnectProviderID(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Custom provider dialog */}
      <Dialog
        open={showCustom}
        onOpenChange={(open) => {
          if (!open) setShowCustom(false);
        }}
      >
        <DialogContent>
          <DialogTitle className="sr-only">Custom provider</DialogTitle>
          <DialogCustomProvider
            directory={scopedDirectory}
            backendId={backendId}
            onSaved={handleConnected}
            onBack={() => setShowCustom(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Select all providers dialog */}
      <Dialog
        open={showSelectAll}
        onOpenChange={(open) => {
          if (!open) setShowSelectAll(false);
        }}
      >
        <DialogContent>
          <DialogTitle className="sr-only">All providers</DialogTitle>
          <DialogSelectProvider
            providers={providerList}
            connectedIds={connectedSet}
            onSelect={(id: string) => {
              setShowSelectAll(false);
              setConnectProviderID(id);
            }}
            onCustom={() => {
              setShowSelectAll(false);
              setShowCustom(true);
            }}
            onBack={() => setShowSelectAll(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
