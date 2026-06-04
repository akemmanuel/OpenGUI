/** First-run onboarding for Everyday Builders. */

import { AlertCircle, ArrowRight, Check, Folder, LoaderCircle, RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppearanceSetting } from "@/components/AppearanceSetting";
import { Button } from "@/components/ui/button";
import { detectSystemLanguage } from "@/i18n";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageSet } from "@/lib/safe-storage";
import { useOpenGuiClient } from "@/protocol/provider";
import { useDesktopShell } from "@/shell/provider";
import type { BackendDetectionResult } from "@/types/electron";
import { useTranslation } from "react-i18next";

type Step = "harness" | "opencode" | "folder" | "appearance" | "finish";
type HarnessState = "detecting" | "ready" | "none" | "error";
type OpenCodeInstallState = "idle" | "installing" | "installed" | "error";

interface Props {
  onComplete: () => void;
}

const EMPTY_BACKEND_STATUS: BackendDetectionResult = {
  opencode: false,
  "claude-code": false,
  pi: false,
  codex: false,
};

function hasHarness(status: BackendDetectionResult) {
  return Object.values(status).some(Boolean);
}

function stepNumber(step: Step) {
  return ["harness", "folder", "appearance", "finish"].indexOf(
    step === "opencode" ? "harness" : step,
  );
}

export function SetupWizard({ onComplete }: Props) {
  const { i18n } = useTranslation();
  const client = useOpenGuiClient();
  const shell = useDesktopShell();
  const [step, setStep] = useState<Step>("harness");
  const [backendStatus, setBackendStatus] = useState<BackendDetectionResult>(EMPTY_BACKEND_STATUS);
  const [harnessState, setHarnessState] = useState<HarnessState>("detecting");
  const [installState, setInstallState] = useState<OpenCodeInstallState>("idle");
  const [folder, setFolder] = useState("");

  const currentStepNumber = stepNumber(step);
  const opencodeInstalled = backendStatus.opencode;
  const canUseAnyHarness = hasHarness(backendStatus);

  const title = useMemo(() => {
    switch (step) {
      case "harness":
        return "Set up coding agents";
      case "opencode":
        return "Set up OpenCode";
      case "folder":
        return "Choose where new chats start";
      case "appearance":
        return "Make OpenGUI yours";
      case "finish":
        return canUseAnyHarness ? "You're ready" : "Setup saved";
    }
  }, [canUseAnyHarness, step]);

  async function refreshHarnessStatus() {
    setHarnessState("detecting");
    try {
      const result =
        (await client.runtime.detectBackends().catch(() => null)) ?? EMPTY_BACKEND_STATUS;
      setBackendStatus(result);
      setHarnessState(hasHarness(result) ? "ready" : "none");
      if (result.opencode) setInstallState("installed");
      return result;
    } catch {
      setBackendStatus(EMPTY_BACKEND_STATUS);
      setHarnessState("error");
      return EMPTY_BACKEND_STATUS;
    }
  }

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (!storageGet(STORAGE_KEYS.LANGUAGE)) {
          const detectedLanguage = await detectSystemLanguage();
          if (!cancelled && i18n.resolvedLanguage !== detectedLanguage) {
            await i18n.changeLanguage(detectedLanguage);
          }
        }
      } catch {
        // Locale detection is non-critical.
      }
    })();

    void (async () => {
      const result = await refreshHarnessStatus();
      if (cancelled) return;
      setBackendStatus(result);
      setHarnessState(hasHarness(result) ? "ready" : "none");
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function installOpenCode() {
    setInstallState("installing");
    try {
      const result = await client.runtime.installBackend("opencode");
      const nextStatus = await refreshHarnessStatus();
      setInstallState(result?.success && nextStatus.opencode ? "installed" : "error");
    } catch {
      setInstallState("error");
    }
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
      <div className="flex min-h-full items-start justify-center px-5 py-6 sm:items-center sm:py-10">
        <div className="w-full max-w-[680px]">
          <div className="mb-5 text-center">
            <div className="mb-2 text-xs text-muted-foreground">
              {Math.max(currentStepNumber, 0) + 1} / 4
            </div>
            <h1 className="mb-1.5 text-xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">OpenGUI only asks for what it needs.</p>
          </div>

          <div className="mb-5 flex justify-center gap-1.5">
            {[0, 1, 2, 3].map((idx) => (
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
            <div className="rounded-xl border bg-card p-5 shadow-sm">
              {harnessState === "detecting" && (
                <StatusRow
                  icon={<LoaderCircle className="size-5 animate-spin" />}
                  title="Checking this computer"
                  description="Looking for installed Harness CLIs."
                />
              )}
              {harnessState === "ready" && (
                <StatusRow
                  icon={<Check className="size-5 text-emerald-500" />}
                  title="Coding agent found"
                  description="OpenGUI found a coding agent on this computer."
                />
              )}
              {harnessState === "none" && (
                <StatusRow
                  icon={<AlertCircle className="size-5 text-amber-500" />}
                  title="No Harness installed"
                  description="OpenGUI needs a coding agent before it can work on your files."
                />
              )}
              {harnessState === "error" && (
                <StatusRow
                  icon={<AlertCircle className="size-5 text-destructive" />}
                  title="Could not check Harnesses"
                  description="You can continue setup and check again later."
                />
              )}

              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={() => void refreshHarnessStatus()}>
                  <RotateCw className="mr-1.5 size-4" />
                  Check again
                </Button>
                {harnessState === "none" && (
                  <Button variant="outline" onClick={() => setStep("folder")}>
                    I want to use another Harness
                  </Button>
                )}
                {harnessState === "none" ? (
                  <Button onClick={() => setStep("opencode")}>Setup</Button>
                ) : (
                  <Button onClick={() => setStep("folder")} disabled={harnessState === "detecting"}>
                    Continue
                    <ArrowRight className="ml-1.5 size-4" />
                  </Button>
                )}
              </div>
            </div>
          )}

          {step === "opencode" && (
            <div className="rounded-xl border bg-card p-5 shadow-sm">
              <StatusRow
                icon={
                  opencodeInstalled ? (
                    <Check className="size-5 text-emerald-500" />
                  ) : (
                    <AlertCircle className="size-5 text-amber-500" />
                  )
                }
                title={opencodeInstalled ? "OpenCode is installed" : "Install OpenCode"}
                description="OpenCode is the guided setup path. Other Harnesses can still be installed manually."
              />
              <div className="mt-5 rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
                Provider connection will happen in OpenGUI after OpenCode is available.
              </div>
              <div className="mt-5 flex flex-wrap justify-between gap-2">
                <Button variant="ghost" onClick={() => setStep("harness")}>
                  Back
                </Button>
                <div className="flex gap-2">
                  {!opencodeInstalled && (
                    <Button
                      onClick={() => void installOpenCode()}
                      disabled={installState === "installing"}
                    >
                      {installState === "installing" && (
                        <LoaderCircle className="mr-1.5 size-4 animate-spin" />
                      )}
                      Install OpenCode
                    </Button>
                  )}
                  <Button
                    variant={opencodeInstalled ? "default" : "outline"}
                    onClick={() => setStep("folder")}
                  >
                    Continue
                    <ArrowRight className="ml-1.5 size-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          {step === "folder" && (
            <div className="rounded-xl border bg-card p-5 shadow-sm">
              <StatusRow
                icon={<Folder className="size-5 text-muted-foreground" />}
                title="Default chat directory"
                description="Optional. New chats can start in this folder when no project is selected."
              />
              <div className="mt-4 flex gap-2">
                <input
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                  placeholder="Choose a folder or leave empty"
                  className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <Button type="button" variant="outline" onClick={browseFolder}>
                  <Folder className="mr-1.5 size-4" />
                  Browse
                </Button>
              </div>
              <StepNav onBack={() => setStep("harness")} onNext={() => setStep("appearance")} />
            </div>
          )}

          {step === "appearance" && (
            <div className="rounded-xl border bg-card p-5 shadow-sm">
              <AppearanceSetting />
              <StepNav onBack={() => setStep("folder")} onNext={() => setStep("finish")} />
            </div>
          )}

          {step === "finish" && (
            <div className="rounded-xl border bg-card p-5 shadow-sm">
              <StatusRow
                icon={<Check className="size-5 text-emerald-500" />}
                title={
                  canUseAnyHarness ? "OpenGUI is ready to work" : "You can set up a Harness later"
                }
                description={
                  canUseAnyHarness
                    ? "Start by connecting a project or opening a session."
                    : "OpenGUI will open now. Agent sends need a Harness before they can run."
                }
              />
              <div className="mt-5 flex justify-between gap-2">
                <Button variant="outline" onClick={() => setStep("appearance")}>
                  Back
                </Button>
                <Button onClick={complete}>Open OpenGUI</Button>
              </div>
            </div>
          )}
        </div>
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
  return (
    <div className="mt-5 flex justify-between gap-2">
      <Button variant="outline" onClick={onBack}>
        Back
      </Button>
      <Button onClick={onNext}>
        Continue
        <ArrowRight className="ml-1.5 size-4" />
      </Button>
    </div>
  );
}
