/** First-run onboarding for Everyday Builders. */

import { ArrowLeft, ArrowRight, Check, Folder } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { openModelConnections } from "@/features/app-shell/open-model-connections";
import { getProjectName } from "@/lib/path";
import { Input } from "@/components/ui/input";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageSet } from "@/lib/persistence/storage";
import { useDesktopShell } from "@/shell/provider";
import { createHostClient } from "@/protocol/host-client";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";
import type { DesktopShellClient } from "@/shell/client";
import { requestProjectPath } from "@/components/ProjectPathDialog";
import { useActions, useModelState } from "@/hooks/use-agent-state";
import type { OpenGuiHostClient } from "@/protocol/host-types";

type Step = "model" | "folder" | "finish";

interface Props {
  onComplete: () => void;
}

function stepNumber(step: Step) {
  const stepToProgressDot: Record<Step, number> = {
    model: 0,
    folder: 1,
    finish: 2,
  };
  return stepToProgressDot[step];
}

function createWizardHostClient() {
  const electronApi = window.electronAPI;
  if (electronApi?.kind === "electron") {
    return createHostClient({
      baseUrl: electronApi.backendUrl ?? "",
      token: electronApi.backendToken ?? undefined,
    });
  }
  const policy = getShellWorkspacePolicy();
  return createHostClient({
    resolveBaseUrl: () => policy.configuredWebWorkspace?.baseUrl || window.location.origin,
    resolveToken: () => policy.configuredWebWorkspace?.authToken || "",
  });
}

export function buildSetupModelConnection(input: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}) {
  const baseUrl = input.baseUrl.trim();
  const modelId = input.modelId.trim();
  if (!baseUrl || !modelId) return null;
  return {
    id: "default",
    label: "Default",
    baseUrl,
    apiKey: input.apiKey.trim() || undefined,
    modelIds: [modelId],
  };
}

export async function saveSetupModelConnection(
  host: Pick<OpenGuiHostClient, "upsertModelConnection">,
  input: { baseUrl: string; apiKey: string; modelId: string },
  refreshProviders: () => Promise<unknown>,
) {
  const connection = buildSetupModelConnection(input);
  if (!connection) return false;
  await host.upsertModelConnection(connection);
  await refreshProviders();
  return true;
}

export function persistSetupCompletion(folder: string) {
  const defaultDirectory = folder.trim();
  if (defaultDirectory) storageSet(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY, defaultDirectory);
  storageSet(STORAGE_KEYS.SETUP_COMPLETE, "true");
}

type SetupFolderShell = Pick<DesktopShellClient, "runtime" | "dialog">;

export async function selectSetupFolder(
  shell: SetupFolderShell,
  initialPath: string,
  openHostDirectory: (initialPath?: string) => Promise<string | null> = (path) =>
    requestProjectPath(path, "default"),
) {
  return shell.runtime.isElectron
    ? shell.dialog.openDirectory()
    : openHostDirectory(initialPath.trim() || undefined);
}

export function SetupWizard({ onComplete }: Props) {
  const { t } = useTranslation();
  const shell = useDesktopShell();
  const { refreshProviders, connectToProject } = useActions();
  const { providers } = useModelState();
  const hasModel = providers.some((entry) => Object.keys(entry.models).length > 0);
  const host = useMemo(() => createWizardHostClient(), []);
  const [step, setStep] = useState<Step>(hasModel ? "folder" : "model");
  const [showManual, setShowManual] = useState(false);
  const [folder, setFolder] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [modelConfigured, setModelConfigured] = useState(hasModel);
  const [openingProject, setOpeningProject] = useState(false);
  const [projectError, setProjectError] = useState(false);
  const currentStepNumber = stepNumber(step);
  const canSaveModel = Boolean(customUrl.trim() && customModel.trim());

  const title = useMemo(() => {
    switch (step) {
      case "model":
        return t(showManual ? "providers.customBackendTitle" : "setupWizard.connectModelTitle");
      case "folder":
        return t("setupWizard.chooseStartTitle");
      case "finish":
        return t(modelConfigured ? "setupWizard.readyTitle" : "setupWizard.finishWithoutModel");
    }
  }, [modelConfigured, showManual, step, t]);

  async function browseFolder() {
    try {
      const nextDirectory = await selectSetupFolder(shell, folder);
      if (nextDirectory) setFolder(nextDirectory);
    } catch {
      // Dialog unavailable; user can type/paste later in settings.
    }
  }

  async function saveModelAndContinue() {
    if (!canSaveModel || savingModel) return;
    setModelError(false);
    setSavingModel(true);
    try {
      const saved = await saveSetupModelConnection(
        host,
        { baseUrl: customUrl, apiKey: customKey, modelId: customModel },
        refreshProviders,
      );
      if (saved) {
        setModelConfigured(true);
        setStep("folder");
      }
    } catch {
      setModelError(true);
    } finally {
      setSavingModel(false);
    }
  }

  function complete(directory = "") {
    persistSetupCompletion(directory);
    onComplete();
  }

  async function openFirstProject() {
    setProjectError(false);
    setOpeningProject(true);
    try {
      const directory =
        folder.trim() || (await selectSetupFolder(shell, "", (path) => requestProjectPath(path)));
      if (!directory) return;
      await connectToProject(directory);
      complete(directory);
    } catch {
      setProjectError(true);
    } finally {
      setOpeningProject(false);
    }
  }

  const description =
    step === "folder"
      ? t("setupWizard.chooseStartDescription")
      : step === "finish" && !modelConfigured
        ? t("setupWizard.readyWithoutModel")
        : undefined;

  const projectName = folder.trim() ? getProjectName(folder.trim(), folder.trim()) : "";

  return (
    <Dialog open onOpenChange={(open) => !open && !openingProject && !savingModel && complete()}>
      <DialogContent
        className={cn(
          "max-h-[calc(100dvh-1.5rem)] w-full max-w-[calc(100%-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-lg",
          step === "model" && "grid-rows-[auto_minmax(0,1fr)] overflow-y-hidden",
        )}
      >
        <header className="space-y-2 px-5 pt-6 sm:px-7">
          <div className="mb-2 flex w-max sm:mb-4 items-center gap-3 text-xs tabular-nums text-muted-foreground">
            <span aria-hidden="true" className="flex gap-1">
              {[0, 1, 2].map((index) => (
                <span
                  key={index}
                  className={
                    index <= currentStepNumber
                      ? "h-1 w-4 rounded-full bg-primary"
                      : "h-1 w-4 rounded-full bg-border"
                  }
                />
              ))}
            </span>
            <span>{currentStepNumber + 1} / 3</span>
          </div>
          <DialogTitle className="text-2xl leading-tight font-semibold tracking-tight text-balance">
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription className="max-w-[48ch] leading-5 sm:leading-6">
              {description}
            </DialogDescription>
          )}
        </header>

        {step === "model" && (
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void saveModelAndContinue();
            }}
          >
            <div className="min-h-0 space-y-2.5 overflow-y-auto overscroll-contain px-5 pt-3 pb-4 sm:space-y-4 sm:px-7 sm:pt-5 sm:pb-5">
              {!showManual ? (
                <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
                  <Button
                    type="button"
                    size="lg"
                    className="h-auto min-h-10 max-w-full whitespace-normal"
                    onClick={() => openModelConnections(true)}
                  >
                    {t("setupWizard.guidedProviderSetup")}
                    <ArrowRight />
                  </Button>
                  <Button
                    type="button"
                    size="lg"
                    variant="outline"
                    className="max-w-full whitespace-normal"
                    onClick={() => setShowManual(true)}
                  >
                    {t("setupWizard.manualConnection")}
                  </Button>
                </div>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={savingModel}
                    onClick={() => setShowManual(false)}
                  >
                    <ArrowLeft />
                    {t("setupWizard.connectionOptions")}
                  </Button>
                  <div className="grid gap-3 sm:grid-cols-[3fr_2fr]">
                    <label className="block min-w-0 space-y-1.5 text-sm font-medium">
                      <span>{t("setupWizard.baseUrl")}</span>
                      <Input
                        className="h-10 bg-background font-normal"
                        value={customUrl}
                        onChange={(event) => setCustomUrl(event.target.value)}
                        type="url"
                        inputMode="url"
                        placeholder="https://api.example.com/v1"
                      />
                    </label>
                    <label className="block min-w-0 space-y-1.5 text-sm font-medium">
                      <span>{t("setupWizard.model")}</span>
                      <Input
                        className="h-10 bg-background font-normal"
                        value={customModel}
                        onChange={(event) => setCustomModel(event.target.value)}
                        placeholder={t("setupWizard.exampleModel")}
                      />
                    </label>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("setupWizard.otherProviderHelp")}
                  </p>
                  <label className="block space-y-1.5 text-sm font-medium">
                    <span>{t("setupWizard.optionalKey")}</span>
                    <Input
                      className="h-10 bg-background font-normal"
                      value={customKey}
                      onChange={(event) => setCustomKey(event.target.value)}
                      type="password"
                      autoComplete="off"
                    />
                  </label>
                  {modelError && (
                    <p role="alert" className="text-sm text-destructive">
                      {t("setupWizard.modelSaveError")}
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-muted/35 px-5 py-3 sm:px-7 sm:py-4">
              <Button
                type="button"
                size="lg"
                variant="ghost"
                disabled={savingModel}
                onClick={() => setStep("folder")}
              >
                {t("setupWizard.skip")}
              </Button>
              {showManual && (
                <Button type="submit" size="lg" disabled={savingModel || !canSaveModel}>
                  {t("setupWizard.continue")}
                  <ArrowRight />
                </Button>
              )}
            </div>
          </form>
        )}

        {step === "folder" && (
          <>
            <div className="px-5 pt-5 pb-6 sm:px-7">
              <label htmlFor="setup-chat-folder" className="mb-1.5 block text-sm font-medium">
                {t("setupWizard.folderLabel")}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="setup-chat-folder"
                  className="h-10 min-w-36 flex-1 bg-background"
                  placeholder={t("setupWizard.folderPlaceholder")}
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                />
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  onClick={() => void browseFolder()}
                >
                  <Folder />
                  {t("common.browse")}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap justify-between gap-2 border-t bg-muted/35 px-5 py-4 sm:px-7">
              <Button type="button" size="lg" variant="ghost" onClick={() => setStep("model")}>
                {t("common.back")}
              </Button>
              <Button
                type="button"
                size="lg"
                onClick={() => {
                  setProjectError(false);
                  setStep("finish");
                }}
              >
                {t("setupWizard.continue")}
                <ArrowRight />
              </Button>
            </div>
          </>
        )}

        {step === "finish" && (
          <>
            {projectName && (
              <div className="mx-5 mt-5 flex min-w-0 items-center gap-3 rounded-lg border bg-background px-3 py-3 sm:mx-7">
                <Folder className="size-5 shrink-0 text-primary" aria-hidden="true" />
                <span className="min-w-0 truncate text-sm font-medium" title={folder}>
                  {projectName}
                </span>
              </div>
            )}
            {projectError && (
              <p role="alert" className="px-5 pt-4 text-sm text-destructive sm:px-7">
                {t("setupWizard.projectOpenError")}
              </p>
            )}
            <div className="mt-6 grid grid-cols-[1fr_auto] items-center gap-2 border-t bg-muted/35 px-5 py-4 sm:grid-cols-[1fr_auto_auto] sm:px-7">
              <Button
                type="button"
                size="lg"
                variant="ghost"
                disabled={openingProject}
                className="justify-self-start"
                onClick={() => setStep("folder")}
              >
                {t("common.back")}
              </Button>
              <Button
                type="button"
                size="lg"
                variant="ghost"
                disabled={openingProject}
                onClick={() => complete()}
              >
                {t("setupWizard.finishLater")}
              </Button>
              <Button
                type="button"
                size="lg"
                disabled={openingProject}
                className="col-span-2 sm:col-span-1"
                onClick={() => void openFirstProject()}
              >
                {t(
                  openingProject
                    ? "common.loading"
                    : projectName
                      ? "projectPath.openProject"
                      : "setupWizard.chooseProject",
                )}
                <Check />
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
