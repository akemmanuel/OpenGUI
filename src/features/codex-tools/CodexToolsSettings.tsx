import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  getIdentityWorkspace,
  identityWorkspaceIsLocalBypass,
} from "@/features/identity/workspace-identity";
import { notifySuccess, notifyUnknownError } from "@/lib/notify";
import { createHostClient } from "@/protocol/host-client";
import type { CodexToolsSettings as CodexToolsPolicy } from "@/protocol/host-types";

const WEB_SEARCH_MODES = ["live", "cached", "off"] as const;

/** Host policy for ChatGPT web search and image generation on Codex models. */
export function CodexToolsSettings() {
  const { t } = useTranslation();
  const workspace = useMemo(() => getIdentityWorkspace(), []);
  const host = useMemo(() => {
    const electron = window.electronAPI;
    return createHostClient({
      resolveBaseUrl: () => electron?.backendUrl || workspace?.serverUrl || window.location.origin,
      resolveToken: () => electron?.backendToken || workspace?.authToken || "",
    });
  }, [workspace]);
  // Shared offerings only exist on multi-user Hosts.
  const showSharedOfferings = !(workspace && identityWorkspaceIsLocalBypass(workspace));
  const [settings, setSettings] = useState<CodexToolsPolicy | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    void host
      .getCodexToolsSettings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [host, retry]);

  const update = (patch: Partial<CodexToolsPolicy>) => {
    if (pending.current || !settings) return;
    pending.current = true;
    setSaving(true);
    const previous = settings;
    setSettings({ ...settings, ...patch });
    void host
      .setCodexToolsSettings(patch)
      .then((value) => {
        setSettings(value);
        notifySuccess(t("settings.codexTools.saved"));
      })
      .catch((error) => {
        setSettings(previous);
        notifyUnknownError(error);
      })
      .finally(() => {
        pending.current = false;
        setSaving(false);
      });
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="font-medium">{t("settings.codexTools.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings.codexTools.description")}</p>
      </div>
      {loadError ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-destructive">{t("settings.codexTools.loadFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
            {t("common.retry")}
          </Button>
        </div>
      ) : !settings ? (
        <div className="space-y-3" role="status" aria-label={t("common.loading")}>
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-8 w-64" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="codex-tools-web-search">{t("settings.codexTools.webSearch")}</Label>
            <Select
              value={settings.webSearch}
              disabled={saving}
              onValueChange={(value) => {
                if (value && value !== settings.webSearch)
                  update({ webSearch: value as CodexToolsPolicy["webSearch"] });
              }}
            >
              <SelectTrigger id="codex-tools-web-search" className="w-64">
                <SelectValue>
                  {t(`settings.codexTools.webSearchModes.${settings.webSearch}`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {WEB_SEARCH_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`settings.codexTools.webSearchModes.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.codexTools.webSearchDescription")}
            </p>
          </div>
          <ToggleSwitch
            checked={settings.imageGeneration}
            disabled={saving}
            onCheckedChange={(imageGeneration) => update({ imageGeneration })}
            label={t("settings.codexTools.imageGeneration")}
            description={t("settings.codexTools.imageGenerationDescription")}
          />
          {showSharedOfferings && (
            <ToggleSwitch
              checked={settings.sharedOfferings}
              disabled={saving}
              onCheckedChange={(sharedOfferings) => update({ sharedOfferings })}
              label={t("settings.codexTools.sharedOfferings")}
              description={t("settings.codexTools.sharedOfferingsDescription")}
            />
          )}
        </div>
      )}
    </section>
  );
}
