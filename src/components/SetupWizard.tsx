/** First-run onboarding for Everyday Builders. */

import { ArrowRight, Check, Folder, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { MOBILE_BACK_PRIORITY } from "@/shell/mobile-back-handler";
import { useRegisterMobileBackHandler } from "@/shell/useRegisterMobileBackHandler";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageSet } from "@/lib/persistence/storage";
import { useDesktopShell } from "@/shell/provider";
import { createHostClient } from "@/protocol/host-client";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";
import { notifyUnknownError } from "@/lib/notify";

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

export function SetupWizard({ onComplete }: Props) {
  const { t } = useTranslation();
  const shell = useDesktopShell();
  const host = useMemo(() => createWizardHostClient(), []);
  const [step, setStep] = useState<Step>("model");
  const [folder, setFolder] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("gpt-4.1");
  const [savingModel, setSavingModel] = useState(false);
  const stepRef = useRef(step);
  stepRef.current = step;

  useRegisterMobileBackHandler(
    MOBILE_BACK_PRIORITY.SETUP_WIZARD,
    true,
    useCallback(() => {
      const current = stepRef.current;
      if (current === "folder") {
        setStep("model");
        return true;
      }
      if (current === "finish") {
        setStep("folder");
        return true;
      }
      onComplete();
      return true;
    }, [onComplete]),
  );

  const currentStepNumber = stepNumber(step);

  const title = useMemo(() => {
    switch (step) {
      case "model":
        return t("setupWizard.connectModelTitle");
      case "folder":
        return t("setupWizard.chooseStartTitle");
      case "finish":
        return t("setupWizard.readyTitle");
    }
  }, [step, t]);

  async function browseFolder() {
    try {
      const nextDirectory = await shell.dialog.openDirectory();
      if (nextDirectory) setFolder(nextDirectory);
    } catch {
      // Dialog unavailable; user can type/paste later in settings.
    }
  }

  async function saveModelAndContinue() {
    setSavingModel(true);
    try {
      if (baseUrl.trim() && modelId.trim()) {
        await host.upsertModelConnection({
          id: "default",
          label: "Default",
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || undefined,
          modelIds: [modelId.trim()],
        });
      }
      setStep("folder");
    } catch (error) {
      notifyUnknownError(error);
    } finally {
      setSavingModel(false);
    }
  }

  function complete() {
    if (folder.trim()) storageSet(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY, folder.trim());
    storageSet(STORAGE_KEYS.SETUP_COMPLETE, "true");
    onComplete();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-xl border bg-card p-6 shadow-lg">
        <button
          type="button"
          className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-muted"
          onClick={onComplete}
          aria-label={t("common.close")}
        >
          <X className="size-4" />
        </button>

        <div className="mb-4 text-xs text-muted-foreground">{currentStepNumber + 1} / 3</div>
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">{title}</h1>

        {step === "model" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("setupWizard.connectModelDescription")}
            </p>
            <label className="block space-y-1 text-sm">
              <span>{t("setupWizard.baseUrl")}</span>
              <input
                className="w-full rounded-md border bg-background px-3 py-2"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>{t("setupWizard.apiKey")}</span>
              <input
                className="w-full rounded-md border bg-background px-3 py-2"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                type="password"
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>{t("setupWizard.model")}</span>
              <input
                className="w-full rounded-md border bg-background px-3 py-2"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setStep("folder")}>
                {t("setupWizard.skip")}
              </Button>
              <Button
                type="button"
                disabled={savingModel}
                onClick={() => void saveModelAndContinue()}
              >
                {t("setupWizard.continue")}
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        )}

        {step === "folder" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("setupWizard.chooseStartDescription")}
            </p>
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                placeholder={t("setupWizard.folderPlaceholder")}
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
              />
              <Button type="button" variant="outline" onClick={() => void browseFolder()}>
                <Folder className="size-4" />
                {t("common.browse")}
              </Button>
            </div>
            <div className="flex justify-between gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setStep("model")}>
                {t("common.back")}
              </Button>
              <Button type="button" onClick={() => setStep("finish")}>
                {t("setupWizard.continue")}
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        )}

        {step === "finish" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t("setupWizard.readyDescription")}</p>
            <div className="flex justify-between gap-2">
              <Button type="button" variant="ghost" onClick={() => setStep("folder")}>
                {t("common.back")}
              </Button>
              <Button type="button" onClick={complete}>
                <Check className="size-4" />
                {t("setupWizard.openOpenGui")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
