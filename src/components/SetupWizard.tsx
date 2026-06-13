/** First-run onboarding for Everyday Builders. */

import {
  AlertCircle,
  ArrowRight,
  Check,
  Copy,
  Folder,
  LoaderCircle,
  RotateCw,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageSet } from "@/lib/safe-storage";
import { useOpenGuiClient } from "@/protocol/provider";
import { useDesktopShell } from "@/shell/provider";
import type { HarnessInventory } from "@/types/electron";

type Step = "harness" | "opencode" | "folder" | "finish";
type HarnessState = "detecting" | "ready" | "none" | "error";

const OPENCODE_INSTALL_COMMAND = "curl -fsSL https://opencode.ai/install | bash";

interface Props {
  onComplete: () => void;
}

function hasModelReadyHarness(inventories: HarnessInventory[]) {
  return inventories.some(
    (inventory) => inventory.status === "ready" && inventory.models.length > 0,
  );
}

function hasInstalledHarness(inventories: HarnessInventory[]) {
  return inventories.some((inventory) => inventory.installed);
}

function hasUsableHarness(inventories: HarnessInventory[]) {
  return hasModelReadyHarness(inventories) || hasInstalledHarness(inventories);
}

function harnessStateFromInventories(inventories: HarnessInventory[]): HarnessState {
  return hasUsableHarness(inventories) ? "ready" : "none";
}

function stepNumber(step: Step) {
  const stepToProgressDot: Record<Step, number> = {
    harness: 0,
    opencode: 0,
    folder: 1,
    finish: 2,
  };
  return stepToProgressDot[step];
}

export function SetupWizard({ onComplete }: Props) {
  const { t } = useTranslation();
  const client = useOpenGuiClient();
  const shell = useDesktopShell();
  const [step, setStep] = useState<Step>("harness");
  const [inventories, setInventories] = useState<HarnessInventory[]>([]);
  const [harnessState, setHarnessState] = useState<HarnessState>("detecting");
  const [copiedInstallCommand, setCopiedInstallCommand] = useState(false);
  const [folder, setFolder] = useState("");

  const currentStepNumber = stepNumber(step);
  const opencodeInstalled = inventories.some(
    (inventory) => inventory.harnessId === "opencode" && inventory.installed,
  );
  const canUseAnyHarness = hasUsableHarness(inventories);

  const title = useMemo(() => {
    switch (step) {
      case "harness":
        return t("setupWizard.setupAgentsTitle");
      case "opencode":
        return t("setupWizard.setupOpenCodeTitle");
      case "folder":
        return t("setupWizard.chooseStartTitle");
      case "finish":
        return canUseAnyHarness ? t("setupWizard.readyTitle") : t("setupWizard.setupSavedTitle");
    }
  }, [canUseAnyHarness, step, t]);

  async function refreshHarnessStatus(shouldUpdate = () => true) {
    setHarnessState("detecting");
    try {
      const result = await client.runtime.getHarnessInventories().catch(() => []);
      if (!shouldUpdate()) return result;
      setInventories(result);
      setHarnessState(harnessStateFromInventories(result));
      return result;
    } catch {
      if (!shouldUpdate()) return [];
      setInventories([]);
      setHarnessState("error");
      return [];
    }
  }

  useEffect(() => {
    let cancelled = false;

    void refreshHarnessStatus(() => !cancelled);

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyOpenCodeInstallCommand() {
    try {
      await navigator.clipboard.writeText(OPENCODE_INSTALL_COMMAND);
      setCopiedInstallCommand(true);
      window.setTimeout(() => setCopiedInstallCommand(false), 2000);
    } catch {
      setCopiedInstallCommand(false);
    }
  }

  async function openTerminalForOpenCodeInstall() {
    const home = await client.runtime.getHomeDir().catch(() => "");
    await shell.system.openInTerminal(home || folder || "/");
  }

  async function browseFolder() {
    try {
      const nextDirectory = await shell.dialog.openDirectory();
      if (nextDirectory) setFolder(nextDirectory);
    } catch {
      // Dialog unavailable; user can type/paste later in settings.
    }
  }

  function complete() {
    if (folder.trim()) storageSet(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY, folder.trim());
    storageSet(STORAGE_KEYS.SETUP_COMPLETE, "true");
    onComplete();
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background/90 backdrop-blur-md">
      <div className="flex min-h-full items-start justify-center px-4 py-4 sm:items-center sm:py-6">
        <div className="relative max-h-[calc(100dvh-2rem)] w-full max-w-[560px] overflow-y-auto rounded-2xl border bg-background p-4 shadow-xl sm:max-h-[calc(100dvh-3rem)] sm:p-5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 size-8"
            aria-label={t("common.close")}
            onClick={onComplete}
          >
            <X className="size-4" />
          </Button>
          <div className="mb-5 text-center">
            <div className="mb-2 text-xs text-muted-foreground">
              {Math.max(currentStepNumber, 0) + 1} / 3
            </div>
            <h1 className="mb-1.5 text-xl font-semibold tracking-tight">{title}</h1>
          </div>

          <div className="mb-5 flex justify-center gap-1.5">
            {[0, 1, 2].map((idx) => (
              <div
                key={idx}
                className={[
                  "h-1.5 rounded-full transition-all duration-300",
                  idx === currentStepNumber
                    ? "w-8 bg-foreground"
                    : idx < currentStepNumber
                      ? "w-4 bg-foreground/60"
                      : "w-4 bg-muted",
                ].join(" ")}
              />
            ))}
          </div>

          {step === "harness" && (
            <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
              {harnessState === "detecting" && (
                <StatusRow
                  icon={<LoaderCircle className="size-5 animate-spin" />}
                  title={t("setupWizard.checkingComputer")}
                  description={t("setupWizard.lookingForHarnesses")}
                />
              )}
              {harnessState === "ready" && (
                <StatusRow
                  icon={<Check className="size-5 text-emerald-500" />}
                  title={t("setupWizard.codingAgentFound")}
                  description={t("setupWizard.codingAgentFoundDescription")}
                />
              )}
              {harnessState === "none" && (
                <StatusRow
                  icon={<AlertCircle className="size-5 text-amber-500" />}
                  title={t("setupWizard.noHarnessInstalledTitle")}
                  description={t("setupWizard.noHarnessInstalledDescription")}
                />
              )}
              {harnessState === "error" && (
                <StatusRow
                  icon={<AlertCircle className="size-5 text-destructive" />}
                  title={t("setupWizard.checkHarnessesFailedTitle")}
                  description={t("setupWizard.checkHarnessesFailedDescription")}
                />
              )}

              <div className="mt-5 flex flex-wrap justify-between gap-2">
                <Button variant="ghost" onClick={() => void refreshHarnessStatus()}>
                  <RotateCw className="mr-1.5 size-4" />
                  {t("setupWizard.checkAgain")}
                </Button>
                <div className="flex flex-wrap gap-2">
                  {harnessState === "none" && (
                    <Button variant="outline" onClick={() => setStep("folder")}>
                      {t("setupWizard.useAnotherHarness")}
                    </Button>
                  )}
                  {harnessState === "none" ? (
                    <Button onClick={() => setStep("opencode")}>{t("setupWizard.setup")}</Button>
                  ) : (
                    <Button
                      onClick={() => setStep("folder")}
                      disabled={harnessState === "detecting"}
                    >
                      {t("setupWizard.continue")}
                      <ArrowRight className="ml-1.5 size-4" />
                    </Button>
                  )}
                </div>
              </div>
              {inventories.length > 0 && <HarnessInventorySummary inventories={inventories} />}
            </div>
          )}

          {step === "opencode" && (
            <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
              <StatusRow
                icon={
                  opencodeInstalled ? (
                    <Check className="size-5 text-emerald-500" />
                  ) : (
                    <AlertCircle className="size-5 text-amber-500" />
                  )
                }
                title={
                  opencodeInstalled
                    ? t("setupWizard.openCodeInstalled")
                    : t("setupWizard.installOpenCode")
                }
                description={t("setupWizard.openCodeDescription")}
              />
              <div className="mt-5 rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
                {t("setupWizard.providerConnectionAfterOpenCode")}
              </div>
              {!opencodeInstalled && (
                <div className="mt-4 rounded-lg border bg-background p-4">
                  <div className="mb-2 text-sm font-medium">
                    {t("setupWizard.officialOpenCodeInstaller")}
                  </div>
                  <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs text-foreground">
                    {OPENCODE_INSTALL_COMMAND}
                  </code>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("setupWizard.openCodeManualInstallHelp")}
                  </p>
                </div>
              )}
              <div className="mt-5 flex flex-wrap justify-between gap-2">
                <Button variant="ghost" onClick={() => setStep("harness")}>
                  {t("common.back")}
                </Button>
                <div className="flex gap-2">
                  {!opencodeInstalled && (
                    <Button variant="outline" onClick={() => void copyOpenCodeInstallCommand()}>
                      <Copy className="mr-1.5 size-4" />
                      {copiedInstallCommand
                        ? t("setupWizard.copied")
                        : t("setupWizard.copyInstallCommand")}
                    </Button>
                  )}
                  {!opencodeInstalled && (
                    <Button variant="outline" onClick={() => void openTerminalForOpenCodeInstall()}>
                      <Terminal className="mr-1.5 size-4" />
                      {t("setupWizard.openTerminal")}
                    </Button>
                  )}
                  {!opencodeInstalled && (
                    <Button variant="outline" onClick={() => void refreshHarnessStatus()}>
                      <RotateCw className="mr-1.5 size-4" />
                      {t("setupWizard.checkAgain")}
                    </Button>
                  )}
                  <Button
                    variant={opencodeInstalled ? "default" : "outline"}
                    onClick={() => setStep("folder")}
                  >
                    {t("setupWizard.continue")}
                    <ArrowRight className="ml-1.5 size-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          {step === "folder" && (
            <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
              <StatusRow
                icon={<Folder className="size-5 text-muted-foreground" />}
                title={t("setupWizard.defaultChatDirectoryTitle")}
                description={t("setupWizard.defaultChatDirectoryDescription")}
              />
              <div className="mt-4 flex gap-2">
                <input
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                  placeholder={t("setupWizard.folderPlaceholder")}
                  className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <Button type="button" variant="outline" onClick={browseFolder}>
                  <Folder className="mr-1.5 size-4" />
                  {t("common.browse")}
                </Button>
              </div>
              <StepNav onBack={() => setStep("harness")} onNext={() => setStep("finish")} />
            </div>
          )}

          {step === "finish" && (
            <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
              <StatusRow
                icon={<Check className="size-5 text-emerald-500" />}
                title={
                  canUseAnyHarness
                    ? t("setupWizard.readyToWorkTitle")
                    : t("setupWizard.setupHarnessLaterTitle")
                }
                description={
                  canUseAnyHarness
                    ? t("setupWizard.readyToWorkDescription")
                    : t("setupWizard.setupHarnessLaterDescription")
                }
              />
              <div className="mt-5 flex justify-between gap-2">
                <Button variant="outline" onClick={() => setStep("folder")}>
                  {t("common.back")}
                </Button>
                <Button onClick={complete}>{t("setupWizard.openOpenGui")}</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HarnessInventorySummary({ inventories }: { inventories: HarnessInventory[] }) {
  const { t } = useTranslation();

  function getInventoryDescription(inventory: HarnessInventory) {
    if (inventory.status === "ready" && inventory.models.length > 0) {
      return t("setupWizard.harnessReadyDescription");
    }
    if (inventory.installed) {
      return t("setupWizard.harnessCliFoundDescription");
    }
    return t("setupWizard.harnessNotFoundDescription");
  }

  return (
    <div className="mt-5 rounded-lg border bg-muted/20 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("setupWizard.harnessInventoryTitle")}
      </div>
      <div className="space-y-2">
        {inventories.map((inventory) => (
          <div key={inventory.harnessId} className="flex items-start justify-between gap-3 text-sm">
            <div>
              <div className="font-medium">{inventory.displayName}</div>
              <div className="text-xs text-muted-foreground">
                {getInventoryDescription(inventory)}
              </div>
            </div>
            <div className="shrink-0 text-xs text-muted-foreground">
              {inventory.status === "ready"
                ? t("setupWizard.modelsCount", { count: inventory.models.length })
                : inventory.installed
                  ? t("setupWizard.cliFound")
                  : t("setupWizard.notFound")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusRow({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function StepNav({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="mt-5 flex justify-between gap-2">
      <Button variant="outline" onClick={onBack}>
        {t("common.back")}
      </Button>
      <Button onClick={onNext}>
        {t("setupWizard.continue")}
        <ArrowRight className="ml-1.5 size-4" />
      </Button>
    </div>
  );
}
