import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FolderInput,
  Globe,
  Loader2,
  PackagePlus,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Terminal,
  Trash2,
  TrendingUp,
  X,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAgentBackend, useCurrentAgentBackendId } from "@/hooks/use-agent-backend";
import { useConnectionState } from "@/hooks/use-agent-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { BaseDialog } from "@/components/ui/base-dialog";
import type {
  InstalledSkillInfo,
  MarketplaceAuditResponse,
  MarketplaceDetailResponse,
  MarketplaceSkill,
} from "@/types/electron";

type SkillInstallState = {
  exact?: InstalledSkillInfo;
  conflict?: InstalledSkillInfo;
};

function remoteKeyForSkill(skill: MarketplaceSkill) {
  return `${skill.source?.toLowerCase()}@${skill.slug?.toLowerCase()}`;
}

interface SkillCardProps {
  skill: MarketplaceSkill;
  installState: SkillInstallState;
  busy: boolean;
  onInstall: (skill: MarketplaceSkill) => void;
  onUpdate: (installed: InstalledSkillInfo) => void;
  onRemove: (installed: InstalledSkillInfo) => void;
  onClick: (skill: MarketplaceSkill) => void;
}

function SkillCard({
  skill,
  installState,
  busy,
  onInstall,
  onUpdate,
  onRemove,
  onClick,
}: SkillCardProps) {
  const { t } = useTranslation();
  const isHot = skill.change != null && skill.change > 0;
  const installed = installState.exact;
  const conflict = !installed ? installState.conflict : undefined;

  return (
    <button
      type="button"
      onClick={() => onClick(skill)}
      className="group flex flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-all hover:border-primary/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{skill.name}</h3>
            {isHot && (
              <Badge
                variant="default"
                className="shrink-0 bg-orange-500/15 text-orange-600 text-[10px] px-1.5 py-0 hover:bg-orange-500/15"
              >
                <TrendingUp className="size-2.5 mr-0.5" />
                HOT
              </Badge>
            )}
            {installed && (
              <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0">
                <CheckCircle2 className="size-2.5 mr-0.5" />
                {t("settings.marketplace.installed")}
              </Badge>
            )}
            {conflict && (
              <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0">
                <AlertCircle className="size-2.5 mr-0.5" />
                {t("settings.marketplace.nameConflict")}
              </Badge>
            )}
          </div>
          {skill.slug && skill.slug !== skill.name && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{skill.slug}</p>
          )}
          <p className="mt-1.5 text-[11px] text-muted-foreground/60 font-mono truncate">
            {skill.source}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground/70">
          <Star className="size-3 inline mr-0.5 -mt-0.5" />
          {skill.installs.toLocaleString()} {t("settings.marketplace.installsLabel")}
        </span>
        <div className="flex gap-1.5">
          {installed ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdate(installed);
                }}
              >
                {busy ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(installed);
                }}
              >
                <Trash2 className="size-3" />
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant={conflict ? "outline" : "default"}
              className="h-7 px-3 text-xs"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onInstall(skill);
              }}
            >
              {busy ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
              {busy ? t("settings.marketplace.installing") : t("settings.marketplace.install")}
            </Button>
          )}
        </div>
      </div>
    </button>
  );
}

interface InstallFlowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: MarketplaceSkill | null;
  directory: string | undefined;
  onConfirm: (source: string, globalScope: boolean) => void;
}

function InstallFlowDialog({
  open,
  onOpenChange,
  skill,
  directory,
  onConfirm,
}: InstallFlowDialogProps) {
  const { t } = useTranslation();
  const [globalScope, setGlobalScope] = useState(false);

  if (!skill) return null;

  return (
    <BaseDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="inline-flex items-center gap-2">
          <PackagePlus className="size-4" />
          {t("settings.marketplace.install")} {skill.name}
        </span>
      }
      description={
        <span className="inline-flex items-center gap-1.5">
          <Globe className="size-3" />
          {skill.source}/{skill.slug}
        </span>
      }
      className="sm:max-w-sm"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <label
            htmlFor="global-scope"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <input
              type="checkbox"
              id="global-scope"
              checked={globalScope}
              onChange={(e) => setGlobalScope(e.target.checked)}
              className="size-3.5 rounded border-gray-300"
            />
            <Globe className="size-3.5" />
            {t("settings.marketplace.globalScope")}
          </label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              <XCircle className="size-3.5 mr-1" />
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onConfirm(
                  skill.source ? `${skill.source}@${skill.slug}` : skill.id || skill.slug,
                  globalScope,
                );
                onOpenChange(false);
              }}
            >
              <PackagePlus className="size-3.5 mr-1" />
              {t("settings.marketplace.install")}
            </Button>
          </div>
        </div>
      }
    >
      <p className="flex gap-2 text-sm text-muted-foreground">
        <FolderInput className="mt-0.5 size-4 shrink-0" />
        <span>
          {globalScope
            ? t("settings.marketplace.installScopeHelp").replace(
                "Project installs",
                "Installs globally to",
              )
            : directory
              ? t("settings.marketplace.installScopeHelp")
              : t("settings.marketplace.installScopeHelp").replace(
                  "Project installs",
                  "No project directory — installing globally",
                )}
        </span>
      </p>
    </BaseDialog>
  );
}

export function SkillsMarketplace() {
  const { t } = useTranslation();
  const backendId = useCurrentAgentBackendId();
  const backend = useAgentBackend(backendId);
  const marketplaceApi = backend?.platform?.skills?.marketplace;
  const { activeDirectory } = useConnectionState();

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [skills, setSkills] = useState<MarketplaceSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillInfo[]>([]);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [selectedSkill, setSelectedSkill] = useState<MarketplaceSkill | null>(null);
  const [detailData, setDetailData] = useState<MarketplaceDetailResponse | null>(null);
  const [auditData, setAuditData] = useState<MarketplaceAuditResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showInstallFlow, setShowInstallFlow] = useState(false);
  const [installSkill, setInstallSkill] = useState<MarketplaceSkill | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const progressEndRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const scopedDirectory = activeDirectory ?? undefined;

  // Listen for install progress events
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onSkillsInstallProgress) return;
    const unsub = api.onSkillsInstallProgress((data: { chunk: string; type: string }) => {
      setProgressLines((prev) => [...prev, `[${data.type}] ${data.chunk}`]);
    });
    return unsub;
  }, []);

  // Auto-scroll progress
  useEffect(() => {
    progressEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progressLines]);

  // Debounce search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedQuery(query), 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query]);

  // Fetch skills
  const fetchSkills = useCallback(async () => {
    if (!marketplaceApi) return;
    setLoading(true);
    setError(null);
    try {
      if (debouncedQuery) {
        if (debouncedQuery.length < 2) {
          setSkills([]);
          return;
        }
        const res = await marketplaceApi.search(debouncedQuery, 50);
        setSkills(res.data);
      } else {
        const res = await marketplaceApi.list(undefined, 0, 50);
        setSkills(res.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, [marketplaceApi, debouncedQuery]);

  // Fetch installed skills
  const fetchInstalled = useCallback(async () => {
    if (!backend?.platform?.skills) return;
    try {
      const installed: InstalledSkillInfo[] =
        await backend.platform.skills.listInstalled(scopedDirectory);
      setInstalledSkills(installed);
    } catch {}
  }, [backend, scopedDirectory]);

  // Initial load
  useEffect(() => {
    void fetchSkills();
  }, [debouncedQuery]);

  useEffect(() => {
    void fetchInstalled();
  }, [fetchInstalled]);

  // Open detail
  const openDetail = useCallback(
    async (skill: MarketplaceSkill) => {
      setSelectedSkill(skill);
      setDetailLoading(true);
      setDetailData(null);
      setAuditData(null);
      if (marketplaceApi) {
        try {
          const [detail, audit] = await Promise.all([
            marketplaceApi.detail(skill.source, skill.slug),
            marketplaceApi.audit(skill.source, skill.slug).catch(() => null),
          ]);
          setDetailData(detail);
          setAuditData(audit);
        } catch {}
      }
      setDetailLoading(false);
    },
    [marketplaceApi],
  );

  const getInstallState = useCallback(
    (skill: MarketplaceSkill): SkillInstallState => {
      const remoteKey = remoteKeyForSkill(skill);
      const exact = installedSkills.find((installed) => installed.remoteKey === remoteKey);
      if (exact) return { exact };
      const slug = skill.slug?.toLowerCase();
      const name = skill.name?.toLowerCase();
      const conflict = installedSkills.find(
        (installed) =>
          installed.name?.toLowerCase() === name || installed.slug?.toLowerCase() === slug,
      );
      return { conflict };
    },
    [installedSkills],
  );

  const runSkillAction = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setBusyKeys((prev) => new Set(prev).add(key));
      setShowProgress(true);
      setProgressLines([]);
      try {
        await action();
        await fetchInstalled();
      } catch {}
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    },
    [fetchInstalled],
  );

  // Install
  const handleInstall = useCallback((skill: MarketplaceSkill) => {
    setInstallSkill(skill);
    setShowInstallFlow(true);
  }, []);

  const handleUpdate = useCallback(
    async (installed: InstalledSkillInfo) => {
      const skillsApi = backend?.platform?.skills;
      if (!skillsApi) return;
      const key = installed.remoteKey || installed.location;
      await runSkillAction(key, async () => {
        await skillsApi.update(installed.name, scopedDirectory, installed.scope === "global");
      });
    },
    [backend, scopedDirectory, runSkillAction],
  );

  const handleRemove = useCallback(
    async (installed: InstalledSkillInfo) => {
      const skillsApi = backend?.platform?.skills;
      if (!skillsApi) return;
      const key = installed.remoteKey || installed.location;
      await runSkillAction(key, async () => {
        await skillsApi.remove(installed.name, scopedDirectory, installed.scope === "global");
      });
    },
    [backend, scopedDirectory, runSkillAction],
  );

  const confirmInstall = useCallback(
    async (source: string, globalScope: boolean) => {
      const skillsApi = backend?.platform?.skills;
      if (!skillsApi || !installSkill) return;
      const key = remoteKeyForSkill(installSkill);
      await runSkillAction(key, async () => {
        await skillsApi.install(source, scopedDirectory, globalScope);
      });
    },
    [backend, scopedDirectory, runSkillAction, installSkill],
  );

  const selectedInstallState = selectedSkill ? getInstallState(selectedSkill) : {};
  const selectedBusyKey =
    selectedInstallState.exact?.remoteKey ||
    (selectedSkill ? remoteKeyForSkill(selectedSkill) : "");

  if (!marketplaceApi) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-sm text-muted-foreground">{t("settings.skills.cliUnavailable")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-10 pl-9 pr-8 text-sm"
          placeholder={t("settings.marketplace.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
          <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="size-4" />
            {error}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => fetchSkills()}
          >
            {t("settings.marketplace.retry")}
          </Button>
        </div>
      )}

      {/* Skill cards grid */}
      {loading && skills.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <span className="text-xs">{t("settings.marketplace.loading")}</span>
          </div>
        </div>
      ) : skills.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Globe className="size-8 opacity-30" />
            <span className="text-sm">{t("settings.marketplace.noResults")}</span>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {skills.map((skill) => {
              const installState = getInstallState(skill);
              const busyKey = installState.exact?.remoteKey || remoteKeyForSkill(skill);
              return (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  installState={installState}
                  busy={busyKeys.has(busyKey)}
                  onInstall={handleInstall}
                  onUpdate={handleUpdate}
                  onRemove={handleRemove}
                  onClick={openDetail}
                />
              );
            })}
          </div>

          {loading && skills.length > 0 && (
            <div className="flex justify-center py-4">
              <Spinner className="size-5" />
            </div>
          )}
        </>
      )}

      {/* Detail dialog */}
      <BaseDialog
        open={selectedSkill !== null && !showInstallFlow}
        onOpenChange={(open) => {
          if (!open) setSelectedSkill(null);
        }}
        title={selectedSkill?.name || ""}
        description={selectedSkill ? `${selectedSkill.source}/${selectedSkill.slug}` : ""}
        className="sm:max-w-2xl max-h-[80vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden pr-3"
        headerClassName="border-b pb-4 pr-8"
        bodyClassName="overflow-y-auto pr-3"
        footerClassName="border-t bg-background pt-4"
        footer={
          selectedSkill && (
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Star className="size-3" />
                {selectedSkill.installs.toLocaleString()} {t("settings.marketplace.installsLabel")}
                {selectedSkill.installUrl && (
                  <a
                    href={selectedSkill.installUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <ExternalLink className="size-3" />
                    {t("settings.marketplace.source")}
                  </a>
                )}
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                {selectedInstallState.exact ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busyKeys.has(selectedBusyKey)}
                      onClick={() => handleUpdate(selectedInstallState.exact!)}
                    >
                      <RefreshCw className="size-3.5 mr-1" />
                      {t("settings.skills.update")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      disabled={busyKeys.has(selectedBusyKey)}
                      onClick={() => handleRemove(selectedInstallState.exact!)}
                    >
                      <Trash2 className="size-3.5 mr-1" />
                      {t("settings.skills.remove")}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant={selectedInstallState.conflict ? "outline" : "default"}
                    disabled={busyKeys.has(selectedBusyKey)}
                    onClick={() => {
                      setShowInstallFlow(true);
                    }}
                  >
                    {busyKeys.has(selectedBusyKey) ? (
                      <Loader2 className="size-3 animate-spin mr-1" />
                    ) : (
                      <PackagePlus className="size-3.5 mr-1" />
                    )}
                    {t("settings.marketplace.install")}
                  </Button>
                )}
              </div>
            </div>
          )
        }
      >
        {detailLoading ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-5" />
          </div>
        ) : detailData ? (
          <div className="space-y-4">
            {/* SKILL.md content */}
            {detailData.files?.map((file) => (
              <details key={file.path} className="group rounded-lg border bg-muted/30">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                  <Terminal className="size-3" />
                  <span className="flex-1 truncate">{file.path}</span>
                </summary>
                <pre className="max-h-80 overflow-auto border-t bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
                  {file.contents}
                </pre>
              </details>
            ))}

            {/* Audit results */}
            {auditData?.audits && auditData.audits.length > 0 && (
              <div className="space-y-2">
                <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <ShieldCheck className="size-3.5" />
                  {t("settings.marketplace.audit")}
                </h4>
                <div className="space-y-1.5">
                  {auditData.audits.map((a) => (
                    <div
                      key={a.slug}
                      className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
                    >
                      <Badge
                        variant={
                          a.status === "pass"
                            ? "secondary"
                            : a.status === "warn"
                              ? "default"
                              : "destructive"
                        }
                        className="text-[10px] px-1.5 py-0"
                      >
                        {a.status}
                      </Badge>
                      <span className="font-medium">{a.provider}</span>
                      <span className="text-muted-foreground">{a.summary}</span>
                      {a.riskLevel && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 ml-auto">
                          {a.riskLevel}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </BaseDialog>

      {/* Install flow dialog */}
      <InstallFlowDialog
        open={showInstallFlow}
        onOpenChange={setShowInstallFlow}
        skill={installSkill}
        directory={scopedDirectory}
        onConfirm={confirmInstall}
      />

      {/* Progress dialog */}
      <BaseDialog
        open={showProgress}
        onOpenChange={setShowProgress}
        title={
          <span className="inline-flex items-center gap-2">
            <Terminal className="size-4" />
            Install Progress
          </span>
        }
        className="sm:max-w-lg"
        footer={
          <Button type="button" variant="outline" size="sm" onClick={() => setShowProgress(false)}>
            <XCircle className="size-3.5 mr-1" />
            {t("common.close")}
          </Button>
        }
      >
        <div className="max-h-60 overflow-auto rounded-lg bg-black p-3 font-mono text-[11px] leading-relaxed text-green-400">
          {progressLines.length === 0 ? (
            <span className="text-muted-foreground">Starting...</span>
          ) : (
            progressLines.map((line, i) => <div key={i}>{line}</div>)
          )}
          <div ref={progressEndRef} />
        </div>
      </BaseDialog>
    </div>
  );
}
