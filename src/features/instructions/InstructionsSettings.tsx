import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useIdentityActor } from "@/features/identity/identity-actor-context";
import {
  getIdentityWorkspace,
  identityWorkspaceIsLocalBypass,
} from "@/features/identity/workspace-identity";
import { notifySuccess, notifyUnknownError } from "@/lib/notify";
import { createHostClient } from "@/protocol/host-client";

const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 32_000;

export function InstructionsSettings() {
  const { t } = useTranslation();
  const actor = useIdentityActor();
  const workspace = useMemo(() => getIdentityWorkspace(), []);
  const localBypass = Boolean(workspace && identityWorkspaceIsLocalBypass(workspace));
  const canEdit =
    localBypass || (actor?.type === "user" && (actor.role === "owner" || actor.role === "admin"));
  const host = useMemo(() => {
    const electron = window.electronAPI;
    return createHostClient({
      resolveBaseUrl: () => electron?.backendUrl || workspace?.serverUrl || window.location.origin,
      resolveToken: () => electron?.backendToken || workspace?.authToken || "",
    });
  }, [workspace]);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const overLimit = draft.length > MAX_CUSTOM_INSTRUCTIONS_LENGTH;
  const dirty = draft !== saved;

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const text = await host.getCustomInstructions();
      setDraft(text);
      setSaved(text);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!canEdit || overLimit) return;
    setSaving(true);
    try {
      const text = await host.setCustomInstructions(draft);
      setDraft(text);
      setSaved(text);
      notifySuccess(t("settings.instructions.saved"));
    } catch (error) {
      notifyUnknownError(error);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div role="alert" className="space-y-3">
        <p className="text-sm text-destructive">{t("settings.instructions.loadFailed")}</p>
        <p className="text-sm text-muted-foreground">{loadError}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="custom-instructions" className="text-sm font-medium">
          {t("settings.instructions.label")}
        </Label>
        <p className="max-w-[70ch] text-sm leading-6 text-muted-foreground">
          {canEdit ? t("settings.instructions.help") : t("settings.instructions.readOnly")}
        </p>
      </div>
      <textarea
        id="custom-instructions"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={!canEdit}
        rows={14}
        spellCheck
        placeholder={t("settings.instructions.placeholder")}
        className="min-h-56 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2.5 font-mono text-sm leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-70 dark:bg-input/30"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          className={`text-xs tabular-nums ${overLimit ? "text-destructive" : "text-muted-foreground"}`}
        >
          {t("settings.instructions.characterCount", {
            count: draft.length,
            max: MAX_CUSTOM_INSTRUCTIONS_LENGTH,
          })}
        </p>
        {canEdit && (
          <Button
            type="button"
            disabled={!dirty || saving || overLimit}
            onClick={() => void save()}
          >
            {saving ? t("common.loading") : t("settings.instructions.save")}
          </Button>
        )}
      </div>
    </div>
  );
}
