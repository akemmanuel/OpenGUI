import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { HarnessId } from "@/agents";
import { getSessionDirectory } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import { ensureHarnessResourceCatalog } from "@/lib/ensure-harness-resource-catalog";
import {
  getCachedResourceBundle,
  isCatalogKeyPending,
  makeCatalogKey,
  subscribeResourceCatalogCache,
} from "@/lib/resource-catalog-cache";
import type { OpenGuiClient } from "@/protocol/client";
import type { ProvidersData, Workspace } from "@/types/electron";

export type ModelSelectorCatalogTarget = {
  directory: string | null;
  workspaceId: string;
  baseUrl?: string;
  authToken?: string;
};

export function resolveModelSelectorCatalogTarget(input: {
  activeSession: Session | null;
  activeTargetDirectory: string | null;
  activeWorkspace: Workspace | null | undefined;
  activeWorkspaceId: string;
}): ModelSelectorCatalogTarget {
  const directory = input.activeTargetDirectory ?? getSessionDirectory(input.activeSession) ?? null;
  return {
    directory,
    workspaceId: input.activeWorkspaceId,
    baseUrl:
      input.activeWorkspace && !input.activeWorkspace.isLocal
        ? input.activeWorkspace.serverUrl
        : undefined,
    authToken:
      input.activeWorkspace && !input.activeWorkspace.isLocal
        ? input.activeWorkspace.authToken
        : undefined,
  };
}

export function useModelSelectorCatalog(input: {
  open: boolean;
  dialogHarnessId: HarnessId;
  client: OpenGuiClient;
  catalogTarget: ModelSelectorCatalogTarget;
  committedProviders: ProvidersData["providers"];
}) {
  const [catalogFailedKey, setCatalogFailedKey] = useState<string | null>(null);

  const activeCatalogKey = useMemo(
    () =>
      makeCatalogKey({
        harnessId: input.dialogHarnessId,
        workspaceId: input.catalogTarget.workspaceId,
        directory: input.catalogTarget.directory,
        baseUrl: input.catalogTarget.baseUrl,
        authToken: input.catalogTarget.authToken,
      }),
    [input.dialogHarnessId, input.catalogTarget],
  );

  const cachedBundle = useSyncExternalStore(
    subscribeResourceCatalogCache,
    () => getCachedResourceBundle(activeCatalogKey),
    () => getCachedResourceBundle(activeCatalogKey),
  );

  const catalogReady = Boolean(cachedBundle);
  const catalogFailed = catalogFailedKey === activeCatalogKey;
  const catalogLoading =
    input.open && !catalogReady && !catalogFailed && isCatalogKeyPending(activeCatalogKey);
  const catalogTerminal = catalogReady || catalogFailed;

  const catalogProviders = useMemo(() => {
    if (!input.open) return input.committedProviders;
    return cachedBundle?.providersData.providers ?? [];
  }, [input.open, cachedBundle, input.committedProviders]);

  const ensureCatalogForHarness = useCallback(
    async (harnessId: HarnessId) => {
      const key = makeCatalogKey({
        harnessId,
        workspaceId: input.catalogTarget.workspaceId,
        directory: input.catalogTarget.directory,
        baseUrl: input.catalogTarget.baseUrl,
        authToken: input.catalogTarget.authToken,
      });
      setCatalogFailedKey((failedKey) => (failedKey === key ? null : failedKey));
      try {
        await ensureHarnessResourceCatalog({
          harnessId,
          target: {
            workspaceId: input.catalogTarget.workspaceId,
            directory: input.catalogTarget.directory,
            baseUrl: input.catalogTarget.baseUrl,
            authToken: input.catalogTarget.authToken,
          },
          client: input.client,
        });
      } catch (error) {
        console.error("Failed to load model catalog", error);
        setCatalogFailedKey(key);
      }
    },
    [input.client, input.catalogTarget],
  );

  return {
    activeCatalogKey,
    catalogReady,
    catalogFailed,
    catalogLoading,
    catalogTerminal,
    catalogProviders,
    ensureCatalogForHarness,
  };
}
