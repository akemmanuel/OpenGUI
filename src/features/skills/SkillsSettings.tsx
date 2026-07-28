import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Download,
  FileText,
  GitFork,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIdentityActor } from "@/features/identity/identity-actor-context";
import { createIdentityClient } from "@/features/identity/identity-client";
import {
  getIdentityWorkspace,
  identityWorkspaceIsLocalBypass,
} from "@/features/identity/workspace-identity";
import { useWorkspaceState } from "@/hooks/use-agent-state";
import { createHostClient } from "@/protocol/host-client";
import type {
  HostSkillInstallation,
  HostSkillScope,
  HostSkillSourceDescriptor,
} from "@/protocol/host-types";
import {
  filterSkillInstallations,
  isSupportedSkillSource,
  pathHasWriteGrant,
  skillManagementAccess,
} from "./skills-library-state";

type Operation = "install" | "update" | "remove";
type RowState = { operation: Operation; status: "working" | "success" | "error"; error?: string };
type Confirmation =
  | { operation: "install"; source: string; scope: HostSkillScope }
  | { operation: "update" | "remove"; skill: HostSkillInstallation };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function shortRevision(revision?: string) {
  return revision && revision.length > 12 ? revision.slice(0, 12) : revision;
}

function rowKey(skill: Pick<HostSkillInstallation, "scope" | "name">) {
  return `${skill.scope}:${skill.name}`;
}

export function SkillsSettings() {
  const { t } = useTranslation();
  const actor = useIdentityActor();
  const { activeDirectory } = useWorkspaceState();
  const workspace = useMemo(() => getIdentityWorkspace(), []);
  const localBypass = Boolean(workspace && identityWorkspaceIsLocalBypass(workspace));
  const host = useMemo(() => {
    const electron = window.electronAPI;
    return createHostClient({
      resolveBaseUrl: () => electron?.backendUrl || workspace?.serverUrl || window.location.origin,
      resolveToken: () => electron?.backendToken || workspace?.authToken || "",
    });
  }, [workspace]);
  const [skills, setSkills] = useState<HostSkillInstallation[]>([]);
  const [sources, setSources] = useState<HostSkillSourceDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectWriteAccess, setProjectWriteAccess] = useState<"allowed" | "denied" | "unknown">(
    localBypass || actor?.role === "owner" ? "allowed" : "unknown",
  );
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<HostSkillScope | "all">("all");
  const [installScope, setInstallScope] = useState<HostSkillScope>("project");
  const [source, setSource] = useState("");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const requestIds = useRef(new Map<string, string>());
  const access = skillManagementAccess(actor, projectWriteAccess);
  const canManage = access.canManageHost;

  useEffect(() => {
    if (localBypass || actor?.role === "owner") {
      setProjectWriteAccess("allowed");
      return;
    }
    if (!workspace?.authToken || !activeDirectory || actor?.type !== "user" || !canManage) {
      setProjectWriteAccess(canManage ? "unknown" : "denied");
      return;
    }
    let cancelled = false;
    const identity = createIdentityClient({
      baseUrl: workspace.serverUrl,
      token: workspace.authToken,
    });
    void Promise.all([identity.me(), identity.memberPathGrants(actor.id)])
      .then(([me, grants]) => {
        if (cancelled) return;
        setProjectWriteAccess(
          me.pathPolicy.mode === "disabled" || pathHasWriteGrant(activeDirectory, grants.grants)
            ? "allowed"
            : "denied",
        );
      })
      .catch(() => {
        if (!cancelled) setProjectWriteAccess("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [activeDirectory, actor, canManage, localBypass, workspace]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      if (canManage) {
        const [hostSkills, projectSkills, descriptors] = await Promise.all([
          host.listSkillInstallations("host"),
          activeDirectory
            ? host.listSkillInstallations("project", activeDirectory)
            : Promise.resolve([]),
          host.supportedSkillSources(),
        ]);
        setSkills([...projectSkills, ...hostSkills]);
        setSources(descriptors);
      } else if (activeDirectory) {
        const available = await host.listSkills(activeDirectory);
        setSkills(
          available.map((skill) => ({
            ...skill,
            scope: skill.source,
            location: "",
            managed: false,
            modified: false,
            generation: 0,
          })),
        );
      } else {
        setSkills([]);
      }
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [activeDirectory, canManage, host]);

  useEffect(() => void load(), [load]);

  const visible = useMemo(
    () => filterSkillInstallations(skills, query, scopeFilter),
    [query, scopeFilter, skills],
  );

  function requestId(key: string) {
    const existing = requestIds.current.get(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    requestIds.current.set(key, created);
    return created;
  }

  async function mutate(action: Confirmation) {
    const skill = "skill" in action ? action.skill : null;
    const key = skill ? rowKey(skill) : `${"scope" in action ? action.scope : "project"}:install`;
    const operation = action.operation;
    setConfirmation(null);
    setRows((current) => ({ ...current, [key]: { operation, status: "working" } }));
    try {
      if (action.operation === "install") {
        await host.installManagedSkill({
          source: action.source,
          scope: action.scope,
          ...(action.scope === "project" ? { directory: activeDirectory ?? undefined } : {}),
          requestId: requestId(`${key}:${action.source}`),
        });
        setSource("");
      } else if (action.operation === "update") {
        await host.updateManagedSkill(action.skill.name, {
          scope: action.skill.scope,
          ...(action.skill.scope === "project" ? { directory: activeDirectory ?? undefined } : {}),
          requestId: requestId(`${key}:update:${action.skill.generation}`),
          expectedGeneration: action.skill.generation,
        });
      } else {
        await host.removeManagedSkill(action.skill.name, {
          scope: action.skill.scope,
          ...(action.skill.scope === "project" ? { directory: activeDirectory ?? undefined } : {}),
          requestId: requestId(`${key}:remove:${action.skill.generation}`),
          expectedGeneration: action.skill.generation,
        });
      }
      requestIds.current.clear();
      setRows((current) => ({ ...current, [key]: { operation, status: "success" } }));
      await load();
    } catch (error) {
      setRows((current) => ({
        ...current,
        [key]: { operation, status: "error", error: errorMessage(error) },
      }));
    }
  }

  const sourceInvalid = source.length > 0 && !isSupportedSkillSource(source);
  const projectActionBlocked =
    installScope === "project" && (!activeDirectory || !access.canManageProject);
  const descriptor = sources[0];

  return (
    <div
      className="min-w-0 space-y-6 break-words [overflow-wrap:anywhere]"
      data-testid="skills-library"
    >
      <section className="rounded-lg bg-muted/40 p-4">
        <div className="flex gap-3">
          <BookOpen className="mt-0.5 size-5 shrink-0 text-foreground" />
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold">{t("skillsSettings.aboutTitle")}</h3>
            <p className="max-w-[70ch] text-sm leading-6 text-muted-foreground">
              {t("skillsSettings.aboutDescription")}
            </p>
            <p className="max-w-[70ch] text-xs leading-5 text-muted-foreground">
              {t("skillsSettings.sessionPins")}
            </p>
          </div>
        </div>
      </section>

      <Tabs defaultValue="installed" className="gap-5">
        <TabsList aria-label={t("skillsSettings.viewsLabel")}>
          <TabsTrigger value="installed">{t("skillsSettings.installed")}</TabsTrigger>
          {canManage && <TabsTrigger value="discover">{t("skillsSettings.discover")}</TabsTrigger>}
        </TabsList>

        <TabsContent value="installed" className="space-y-4">
          {!canManage && (
            <div className="rounded-lg border px-3 py-3 text-sm text-muted-foreground">
              {t("skillsSettings.readOnlyHelp")}
            </div>
          )}
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-11 pl-9"
                aria-label={t("skillsSettings.searchLabel")}
                placeholder={t("skillsSettings.searchPlaceholder")}
              />
            </div>
            <div
              className="flex min-h-11 flex-wrap items-center gap-1"
              aria-label={t("skillsSettings.scopeFilterLabel")}
            >
              {(["all", "project", "host"] as const).map((scope) => (
                <Button
                  key={scope}
                  type="button"
                  size="sm"
                  variant={scopeFilter === scope ? "secondary" : "ghost"}
                  aria-pressed={scopeFilter === scope}
                  onClick={() => setScopeFilter(scope)}
                >
                  {t(`skillsSettings.scope.${scope}`)}
                </Button>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => void load()}
            >
              <RefreshCw /> {t("skillsSettings.refresh")}
            </Button>
          </div>

          {loading ? (
            <div className="space-y-2" role="status" aria-label={t("common.loading")}>
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          ) : loadError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 p-4">
              <div className="flex gap-2 text-sm font-medium text-destructive">
                <AlertCircle className="size-4" />
                {t("skillsSettings.loadFailed")}
              </div>
              <p className="mt-2 break-words text-sm text-muted-foreground">{loadError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void load()}
              >
                {t("skillsSettings.retry")}
              </Button>
            </div>
          ) : !activeDirectory && !canManage ? (
            <EmptyState text={t("skillsSettings.selectProjectReadOnly")} />
          ) : skills.length === 0 ? (
            <EmptyState text={t("skillsSettings.empty")} />
          ) : visible.length === 0 ? (
            <EmptyState text={t("skillsSettings.noResults")} />
          ) : (
            <div className="divide-y rounded-lg border">
              {visible.map((skill) => (
                <SkillRow
                  key={rowKey(skill)}
                  skill={skill}
                  state={rows[rowKey(skill)]}
                  canManage={
                    skill.scope === "host" ? access.canManageHost : access.canManageProject
                  }
                  onUpdate={() => setConfirmation({ operation: "update", skill })}
                  onRemove={() => setConfirmation({ operation: "remove", skill })}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {canManage && (
          <TabsContent value="discover" className="space-y-5">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">{t("skillsSettings.installTitle")}</h3>
              <p className="max-w-[70ch] text-sm leading-6 text-muted-foreground">
                {t("skillsSettings.installDescription")}
              </p>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("skillsSettings.chooseScope")}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(["project", "host"] as const).map((scope) => (
                  <label
                    key={scope}
                    className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-ring has-[:checked]:bg-accent/40"
                  >
                    <input
                      className="mt-1 accent-current"
                      type="radio"
                      name="skill-scope"
                      value={scope}
                      checked={installScope === scope}
                      onChange={() => setInstallScope(scope)}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {t(`skillsSettings.scope.${scope}`)}
                      </span>
                      <span className="block text-xs leading-5 text-muted-foreground">
                        {t(`skillsSettings.scopeHelp.${scope}`)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {projectActionBlocked && (
              <div
                role="status"
                className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-foreground"
              >
                {activeDirectory
                  ? t("skillsSettings.projectWriteRequired")
                  : t("skillsSettings.selectProject")}
              </div>
            )}
            <div className="space-y-2">
              <label htmlFor="skill-source" className="text-sm font-medium">
                {t("skillsSettings.repositorySource")}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="skill-source"
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  aria-invalid={sourceInvalid}
                  className="h-11 min-w-0 font-mono text-xs"
                  placeholder={descriptor?.example ?? "github:OWNER/REPOSITORY/PATH@REF"}
                />
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={
                    !isSupportedSkillSource(source) ||
                    projectActionBlocked ||
                    rows[`${installScope}:install`]?.status === "working"
                  }
                  onClick={() =>
                    setConfirmation({
                      operation: "install",
                      source: source.trim(),
                      scope: installScope,
                    })
                  }
                >
                  {rows[`${installScope}:install`]?.status === "working" ? (
                    <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Download />
                  )}
                  {t("skillsSettings.reviewInstall")}
                </Button>
              </div>
              {sourceInvalid && (
                <p className="text-xs text-destructive">{t("skillsSettings.invalidSource")}</p>
              )}
              <p className="break-words text-xs leading-5 text-muted-foreground">
                {t("skillsSettings.sourceHelp")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MetadataNote
                icon={GitFork}
                title={t("skillsSettings.githubOnlyTitle")}
                text={t("skillsSettings.githubOnlyDescription")}
              />
              <MetadataNote
                icon={ShieldCheck}
                title={t("skillsSettings.trustTitle")}
                text={t("skillsSettings.trustDescription")}
              />
            </div>
            {rows[`${installScope}:install`]?.status === "error" && (
              <OperationError
                state={rows[`${installScope}:install`]!}
                onRetry={() =>
                  setConfirmation({
                    operation: "install",
                    source: source.trim(),
                    scope: installScope,
                  })
                }
              />
            )}
            {rows[`${installScope}:install`]?.status === "success" && (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"
              >
                <CheckCircle2 className="size-4" />
                {t("skillsSettings.success.install")}
              </p>
            )}
          </TabsContent>
        )}
      </Tabs>

      <AlertDialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => !open && setConfirmation(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation
                ? t(`skillsSettings.confirm.${confirmation.operation}Title`, {
                    name: "skill" in confirmation ? confirmation.skill.name : confirmation.source,
                  })
                : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation
                ? t(`skillsSettings.confirm.${confirmation.operation}Description`, {
                    scope: t(
                      `skillsSettings.scope.${"skill" in confirmation ? confirmation.skill.scope : confirmation.scope}`,
                    ),
                  })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmation?.operation === "remove" ? "destructive" : "default"}
              onClick={() => confirmation && void mutate(confirmation)}
            >
              {confirmation ? t(`skillsSettings.confirm.${confirmation.operation}Action`) : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-4 py-8 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function MetadataNote({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof GitFork;
  title: string;
  text: string;
}) {
  return (
    <div className="flex gap-3 rounded-lg border p-3">
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}

function OperationError({ state, onRetry }: { state: RowState; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <p className="break-words text-xs text-destructive">{state.error}</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
        {t("skillsSettings.retrySameRequest")}
      </Button>
    </div>
  );
}

function SkillRow({
  skill,
  state,
  canManage,
  onUpdate,
  onRemove,
}: {
  skill: HostSkillInstallation;
  state?: RowState;
  canManage: boolean;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const working = state?.status === "working";
  return (
    <article className="min-w-0 p-4" aria-busy={working}>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start">
        <BookOpen className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="break-words text-sm font-semibold">{skill.name}</h4>
            <Badge variant="outline">{t(`skillsSettings.scope.${skill.scope}`)}</Badge>
            {skill.manual && <Badge variant="secondary">{t("skillsSettings.manual")}</Badge>}
            {skill.modified && <Badge variant="destructive">{t("skillsSettings.modified")}</Badge>}
          </div>
          <p className="mt-1 max-w-[70ch] break-words text-sm leading-6 text-muted-foreground">
            {skill.description}
          </p>
          <dl className="mt-3 grid min-w-0 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
            <Meta
              label={t("skillsSettings.metadata.source")}
              value={skill.source ?? t("skillsSettings.metadata.localSource")}
            />
            <Meta
              label={t("skillsSettings.metadata.revision")}
              value={shortRevision(skill.revision) ?? t("skillsSettings.metadata.unpinned")}
              title={skill.revision}
            />
            <Meta
              label={t("skillsSettings.metadata.generation")}
              value={
                skill.generation
                  ? String(skill.generation)
                  : t("skillsSettings.metadata.unavailable")
              }
            />
            <Meta
              label={t("skillsSettings.metadata.trust")}
              value={
                skill.managed
                  ? t("skillsSettings.metadata.reviewSource")
                  : t("skillsSettings.metadata.unverified")
              }
            />
          </dl>
          <details className="mt-3 rounded-md bg-muted/40 px-3 py-2">
            <summary className="min-h-6 cursor-pointer text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <FileText className="mr-1.5 inline size-3.5" />
              {t("skillsSettings.preview.title")}
            </summary>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {t("skillsSettings.preview.unavailable")}
            </p>
            {skill.location && (
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                {skill.location}
              </p>
            )}
          </details>
          {skill.modified && (
            <div className="mt-3 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs leading-5">
              <Wrench className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong>{t("skillsSettings.repairTitle")}</strong>{" "}
                {t("skillsSettings.repairDescription")}
              </span>
            </div>
          )}
          {state?.status === "working" && (
            <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              {t(`skillsSettings.progress.${state.operation}`)}
            </p>
          )}
          {state?.status === "success" && (
            <p
              role="status"
              className="mt-3 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400"
            >
              <CheckCircle2 className="size-4" />
              {t(`skillsSettings.success.${state.operation}`)}
            </p>
          )}
          {state?.status === "error" && (
            <OperationError
              state={state}
              onRetry={state.operation === "update" ? onUpdate : onRemove}
            />
          )}
        </div>
        {canManage && skill.managed && (
          <div className="flex shrink-0 gap-2 sm:flex-col">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 flex-1"
              disabled={working || skill.modified}
              onClick={onUpdate}
            >
              <RefreshCw />
              {t("skillsSettings.update")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 flex-1 text-destructive hover:text-destructive"
              disabled={working || skill.modified}
              onClick={onRemove}
            >
              <Trash2 />
              {t("skillsSettings.remove")}
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}

function Meta({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-medium" title={title}>
        {value}
      </dd>
    </div>
  );
}

export { isSupportedSkillSource as isSkillInstallSource };
