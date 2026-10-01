import { useEffect, useMemo, useRef, useState } from "react";
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
import type { HostProject, OpenGuiHostClient, ProjectInstructions } from "@/protocol/host-types";

const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 32_000;
type Scope = "host" | "personal" | "project";
const selectClass =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-ring";

export function InstructionsSettings() {
  const { t } = useTranslation();
  const actor = useIdentityActor();
  const workspace = useMemo(() => getIdentityWorkspace(), []);
  const localBypass = Boolean(workspace && identityWorkspaceIsLocalBypass(workspace));
  const admin =
    localBypass || (actor?.type === "user" && (actor.role === "owner" || actor.role === "admin"));
  const host = useMemo(() => {
    const electron = window.electronAPI;
    return createHostClient({
      resolveBaseUrl: () => electron?.backendUrl || workspace?.serverUrl || window.location.origin,
      resolveToken: () => electron?.backendToken || workspace?.authToken || "",
    });
  }, [workspace]);
  const [scope, setScope] = useState<Scope>("host");
  const [projects, setProjects] = useState<HostProject[]>([]);
  const [directory, setDirectory] = useState("");
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (scope !== "project") return;
    let cancelled = false;
    setProjectLoading(true);
    setProjectError(false);
    void host
      .listProjects()
      .then((items) => {
        if (cancelled) return;
        setProjects(items);
        setDirectory((current) =>
          items.some((item) => item.directory === current) ? current : (items[0]?.directory ?? ""),
        );
      })
      .catch(() => {
        if (!cancelled) setProjectError(true);
      })
      .finally(() => {
        if (!cancelled) setProjectLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, host, retry]);

  const canLeave = () => !busy && (!dirty || window.confirm(t("settings.instructions.discard")));
  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t("settings.instructions.scopeLabel")}
      >
        {(["host", "project", "personal"] as const)
          .filter((item) => item !== "personal" || localBypass || actor?.type === "user")
          .map((item) => (
            <Button
              key={item}
              type="button"
              size="sm"
              variant={scope === item ? "default" : "outline"}
              aria-pressed={scope === item}
              disabled={busy}
              onClick={() => {
                if (item === scope || !canLeave()) return;
                setDirty(false);
                setScope(item);
              }}
            >
              {t(`settings.instructions.scope.${item}`)}
            </Button>
          ))}
      </div>
      <p className="max-w-[70ch] text-sm leading-6 text-muted-foreground">
        {t("settings.instructions.hierarchy")}
      </p>
      {scope === "project" &&
        (projectLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : projectError ? (
          <div role="alert">
            <p>{t("settings.instructions.loadFailed")}</p>
            <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
              {t("common.retry")}
            </Button>
          </div>
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings.instructions.noProjects")}</p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="instructions-project">{t("settings.instructions.scope.project")}</Label>
            <select
              id="instructions-project"
              className={selectClass}
              value={directory}
              disabled={busy}
              onChange={(event) => {
                if (!canLeave()) return;
                setDirty(false);
                setDirectory(event.target.value);
              }}
            >
              {projects.map((project) => (
                <option key={project.directory} value={project.directory}>
                  {project.name} · {project.directory}
                </option>
              ))}
            </select>
          </div>
        ))}
      {(scope !== "project" || (!projectLoading && !projectError && directory)) && (
        <InstructionsEditor
          key={`${scope}:${directory}`}
          host={host}
          scope={scope}
          directory={directory}
          admin={admin}
          onDirty={setDirty}
          onBusy={setBusy}
        />
      )}
    </div>
  );
}

function InstructionsEditor({
  host,
  scope,
  directory,
  admin,
  onDirty,
  onBusy,
}: {
  host: OpenGuiHostClient;
  scope: Scope;
  directory: string;
  admin: boolean;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [project, setProject] = useState<ProjectInstructions | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const pending = useRef(false);
  const canEdit = scope === "personal" || (scope === "host" ? admin : project?.canEdit === true);
  const overLimit = draft.length > MAX_CUSTOM_INSTRUCTIONS_LENGTH;
  const dirty = draft !== saved;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    const load = async () => {
      try {
        let text: string;
        if (scope === "project") {
          const value = await host.getProjectInstructions(directory);
          if (cancelled) return;
          setProject(value);
          text = value.text;
        } else
          text = await (scope === "host"
            ? host.getCustomInstructions()
            : host.getPersonalInstructions());
        if (!cancelled) {
          setDraft(text);
          setSaved(text);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [scope, directory, host, retry]);

  const mutate = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    onBusy(true);
    try {
      await operation();
    } catch (error) {
      notifyUnknownError(error);
    } finally {
      pending.current = false;
      setSaving(false);
      onBusy(false);
    }
  };
  const save = () => {
    if (!canEdit || overLimit) return;
    void mutate(async () => {
      const text = await (scope === "host"
        ? host.setCustomInstructions(draft)
        : scope === "personal"
          ? host.setPersonalInstructions(draft)
          : host.setProjectInstructions(directory, draft));
      setDraft(text);
      setSaved(text);
      notifySuccess(t("settings.instructions.saved"));
    });
  };

  if (loading)
    return (
      <div className="space-y-3" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-48" />
      </div>
    );
  if (loadError)
    return (
      <div role="alert" className="space-y-3">
        <p className="text-sm text-destructive">{t("settings.instructions.loadFailed")}</p>
        <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
          {t("common.retry")}
        </Button>
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="custom-instructions" className="text-sm font-medium">
          {t("settings.instructions.label")}
        </Label>
        <p id="instructions-help" className="max-w-[70ch] text-sm leading-6 text-muted-foreground">
          {canEdit
            ? t(`settings.instructions.helpScope.${scope}`)
            : t(
                scope === "host"
                  ? "settings.instructions.readOnly"
                  : "settings.instructions.projectReadOnly",
              )}
        </p>
      </div>
      <textarea
        id="custom-instructions"
        aria-describedby="instructions-help instructions-count"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={!canEdit || saving}
        rows={14}
        spellCheck
        placeholder={t("settings.instructions.placeholder")}
        className="min-h-56 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2.5 text-base leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-70 dark:bg-input/30"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          id="instructions-count"
          className={`text-xs tabular-nums ${overLimit ? "text-destructive" : "text-muted-foreground"}`}
        >
          {t("settings.instructions.characterCount", {
            count: draft.length,
            max: MAX_CUSTOM_INSTRUCTIONS_LENGTH,
          })}
        </p>
        {canEdit && (
          <Button type="button" disabled={!dirty || saving || overLimit} onClick={save}>
            {saving ? t("common.loading") : t("settings.instructions.save")}
          </Button>
        )}
      </div>
      {project?.canManage && (
        <fieldset disabled={saving} className="space-y-3 border-t pt-4">
          <legend className="text-sm font-medium">{t("settings.instructions.editors")}</legend>
          <p className="max-w-[70ch] text-sm leading-6 text-muted-foreground">
            {t("settings.instructions.editorsHelp")}
          </p>
          {project.teams.map((team) => (
            <label key={team.id} className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={team.allowed}
                onChange={(event) => {
                  const allowed = event.target.checked;
                  void mutate(async () => {
                    await host.setProjectInstructionEditor(directory, team.id, allowed);
                    setProject(
                      (current) =>
                        current && {
                          ...current,
                          teams: current.teams.map((item) =>
                            item.id === team.id ? { ...item, allowed } : item,
                          ),
                        },
                    );
                  });
                }}
              />
              <span className="min-w-0 break-words">{team.name}</span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
