import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useIdentityActor } from "@/features/identity/identity-actor-context";
import {
  getIdentityWorkspace,
  identityWorkspaceIsLocalBypass,
} from "@/features/identity/workspace-identity";
import { notifySuccess, notifyUnknownError } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { createHostClient } from "@/protocol/host-client";
import type { HostProject, OpenGuiHostClient, ProjectInstructions } from "@/protocol/host-types";

const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 32_000;
type Scope = "host" | "personal" | "project";
type SharedScope = Exclude<Scope, "personal">;

function useInstructionsHost() {
  const workspace = useMemo(() => getIdentityWorkspace(), []);
  const host = useMemo(() => {
    const electron = window.electronAPI;
    return createHostClient({
      resolveBaseUrl: () => electron?.backendUrl || workspace?.serverUrl || window.location.origin,
      resolveToken: () => electron?.backendToken || workspace?.authToken || "",
    });
  }, [workspace]);
  return { workspace, host };
}

/** Whether the current actor has private personal instructions on this Host. */
export function usePersonalInstructionsAvailable() {
  const actor = useIdentityActor();
  const workspace = useMemo(() => getIdentityWorkspace(), []);
  return Boolean(workspace && identityWorkspaceIsLocalBypass(workspace)) || actor?.type === "user";
}

/** Shared house rules: Host-wide and per project. Personal preferences live in the profile. */
export function InstructionsSettings() {
  const { t } = useTranslation();
  const actor = useIdentityActor();
  const { workspace, host } = useInstructionsHost();
  const localBypass = Boolean(workspace && identityWorkspaceIsLocalBypass(workspace));
  const admin =
    localBypass || (actor?.type === "user" && (actor.role === "owner" || actor.role === "admin"));
  const [scope, setScope] = useState<SharedScope>("host");
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
        {(["host", "project"] as const).map((item) => (
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
            <Select
              value={directory}
              disabled={busy}
              onValueChange={(value) => {
                if (!value || !canLeave()) return;
                setDirty(false);
                setDirectory(value);
              }}
            >
              <SelectTrigger id="instructions-project" className="w-full">
                <SelectValue>
                  {projects.find((project) => project.directory === directory)?.name ?? directory}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.directory} value={project.directory}>
                    {project.name} · {project.directory}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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

/** Private preferences applied to the current account's prompts, sized for the profile panel. */
export function PersonalInstructions({ onDirty }: { onDirty?: (dirty: boolean) => void }) {
  const { host } = useInstructionsHost();
  return (
    <InstructionsEditor
      host={host}
      scope="personal"
      directory=""
      admin={false}
      compact
      onDirty={onDirty ?? noop}
      onBusy={noop}
    />
  );
}

function noop() {}

function InstructionsEditor({
  host,
  scope,
  directory,
  admin,
  compact = false,
  onDirty,
  onBusy,
}: {
  host: OpenGuiHostClient;
  scope: Scope;
  directory: string;
  admin: boolean;
  compact?: boolean;
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

  const editorId = compact ? "personal-instructions" : "custom-instructions";
  const helpId = `${editorId}-help`;
  const countId = `${editorId}-count`;
  return (
    <div className={compact ? "space-y-2" : "space-y-4"}>
      <div className={compact ? "sr-only" : "space-y-1"}>
        <Label htmlFor={editorId} className="text-sm font-medium">
          {t(compact ? "profile.personalInstructions" : "settings.instructions.label")}
        </Label>
      </div>
      <div>
        <p
          id={helpId}
          className={
            compact
              ? "text-xs leading-5 text-muted-foreground"
              : "max-w-[70ch] text-sm leading-6 text-muted-foreground"
          }
        >
          {canEdit
            ? t(`settings.instructions.helpScope.${scope}`)
            : t(
                scope === "host"
                  ? "settings.instructions.readOnly"
                  : "settings.instructions.projectReadOnly",
              )}
        </p>
      </div>
      <Textarea
        id={editorId}
        aria-describedby={`${helpId} ${countId}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={!canEdit || saving}
        rows={compact ? 6 : 14}
        spellCheck
        placeholder={t(
          compact ? "profile.personalInstructionsPlaceholder" : "settings.instructions.placeholder",
        )}
        className={cn(
          "max-h-[60vh] resize-y px-3 py-2.5 leading-6",
          compact ? "min-h-32 text-sm md:text-sm" : "min-h-56",
        )}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          id={countId}
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
            size={compact ? "sm" : "default"}
            disabled={!dirty || saving || overLimit}
            onClick={save}
          >
            {saving
              ? t("common.loading")
              : t(compact ? "common.save" : "settings.instructions.save")}
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
            <Label key={team.id} className="flex items-center gap-3 text-sm font-normal">
              <Checkbox
                checked={team.allowed}
                onCheckedChange={(allowed) => {
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
            </Label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
