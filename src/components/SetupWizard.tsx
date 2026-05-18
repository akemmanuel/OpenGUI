/**
 * SetupWizard – First-run onboarding overlay.
 *
 * Step 1: Choose AI agent backend (4 cards with real provider icons, B&W)
 * Step 2: Optional default project folder
 * Step 3: Requirements check + install hints for the chosen backend
 */

import {
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  Folder,
  LoaderCircle,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentBackendId } from "@/agents";
import { Button } from "@/components/ui/button";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageSet } from "@/lib/safe-storage";
import { detectSystemLanguage } from "@/i18n";
import type { BackendDetectionResult } from "@/types/electron";

// ---------------------------------------------------------------------------
// Inline B&W provider icons (currentColor → adapts to dark/light mode)
// ---------------------------------------------------------------------------

function OpenCodeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 300" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      {/* Inner square – lighter weight */}
      <path d="M180 240H60V120H180V240Z" fill="currentColor" opacity="0.35" />
      {/* Outer frame */}
      <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="currentColor" />
    </svg>
  );
}

function ClaudeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 257" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path
        fill="currentColor"
        d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"
      />
    </svg>
  );
}

function PiIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <path fill="currentColor" d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  );
}

function CodexIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Backend definitions
// ---------------------------------------------------------------------------

interface BackendDef {
  id: AgentBackendId;
  label: string;
  maker: string;
  tagline: string;
  features: string[];
  requirement: string;
  installCmd: string;
  envKey?: string;
  docsUrl: string;
  recommended?: boolean;
  Icon: React.ComponentType<{ className?: string }>;
}

const BACKENDS: BackendDef[] = [
  {
    id: "opencode",
    label: "OpenCode",
    maker: "opencode.ai",
    tagline: "Open-source AI coding agent",
    features: [
      "30+ providers (Anthropic, OpenAI, Google…)",
      "Session management & MCP tools",
      "Runs as a local server on your machine",
    ],
    requirement: "opencode CLI in PATH or ~/.opencode/bin/opencode",
    installCmd: "npm install -g opencode-ai\npnpm add -g opencode-ai\nbun install -g opencode-ai",
    docsUrl: "https://opencode.ai",
    recommended: true,
    Icon: OpenCodeIcon,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    maker: "Anthropic",
    tagline: "Anthropic's official coding agent",
    features: [
      "Powered by Claude Sonnet & Opus",
      "Deep multi-file context understanding",
      "Official Anthropic agentic toolchain",
    ],
    requirement: "claude CLI in PATH or ~/.claude/local/claude",
    installCmd:
      "npm install -g @anthropic-ai/claude-code\npnpm add -g @anthropic-ai/claude-code\nbun install -g @anthropic-ai/claude-code",
    envKey: "ANTHROPIC_API_KEY",
    docsUrl: "https://docs.anthropic.com/claude-code",
    Icon: ClaudeIcon,
  },
  {
    id: "pi",
    label: "Pi",
    maker: "Mario Zechner",
    tagline: "Lightweight & privacy-focused agent",
    features: [
      "Minimal resource footprint",
      "Fast responses for focused tasks",
      "No cloud dependency by default",
    ],
    requirement: "pi agent installed",
    installCmd:
      "npm install -g @earendil-works/pi-coding-agent\npnpm add -g @earendil-works/pi-coding-agent\nbun install -g @earendil-works/pi-coding-agent",
    docsUrl: "https://github.com/badlogic/pi",
    Icon: PiIcon,
  },
  {
    id: "codex",
    label: "Codex",
    maker: "OpenAI",
    tagline: "OpenAI's Codex CLI agent",
    features: [
      "Powered by GPT-4o",
      "Fast code generation & editing",
      "Seamless OpenAI ecosystem integration",
    ],
    requirement: "codex CLI in PATH",
    installCmd:
      "npm install -g @openai/codex\npnpm add -g @openai/codex\nbun install -g @openai/codex",
    envKey: "OPENAI_API_KEY",
    docsUrl: "https://github.com/openai/codex",
    Icon: CodexIcon,
  },
];

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

type Step = "backends" | "folder";

interface Props {
  onComplete: () => void;
}

const EMPTY_BACKEND_STATUS: BackendDetectionResult = {
  opencode: false,
  "claude-code": false,
  pi: false,
  codex: false,
};

export function SetupWizard({ onComplete }: Props) {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState<Step>("backends");
  const [folder, setFolder] = useState("");
  const [backendStatus, setBackendStatus] = useState<BackendDetectionResult>(EMPTY_BACKEND_STATUS);
  const [isDetectingBackends, setIsDetectingBackends] = useState(true);

  type InstallState = "idle" | "installing" | "success" | "error";
  const [installStates, setInstallStates] = useState<Record<string, InstallState>>({});
  const [installLogs, setInstallLogs] = useState<Record<string, string>>({});
  const logRefs = useRef<Record<string, HTMLPreElement | null>>({});

  useEffect(() => {
    for (const id of Object.keys(installLogs)) {
      const el = logRefs.current[id];
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [installLogs]);

  async function refreshBackendStatus() {
    const result = (await window.electronAPI?.detectBackends?.()) ?? EMPTY_BACKEND_STATUS;
    setBackendStatus(result);
  }

  async function handleInstall(backend: BackendDef) {
    setInstallStates((prev) => ({ ...prev, [backend.id]: "installing" }));
    setInstallLogs((prev) => ({ ...prev, [backend.id]: "" }));

    const cleanup = window.electronAPI?.onInstallProgress?.((progress) => {
      setInstallLogs((prev) => ({
        ...prev,
        [backend.id]: (prev[backend.id] ?? "") + progress.chunk,
      }));
    });

    try {
      const result = await window.electronAPI?.installBackend?.(backend.id);
      await refreshBackendStatus();
      setInstallStates((prev) => ({
        ...prev,
        [backend.id]: result?.success ? "success" : "error",
      }));
    } catch {
      setInstallStates((prev) => ({ ...prev, [backend.id]: "error" }));
    } finally {
      cleanup?.();
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
        // ignore locale detection issues in onboarding
      }
    })();

    void (async () => {
      try {
        const result = (await window.electronAPI?.detectBackends?.()) ?? EMPTY_BACKEND_STATUS;
        if (!cancelled) setBackendStatus(result);
      } catch {
        if (!cancelled) setBackendStatus(EMPTY_BACKEND_STATUS);
      } finally {
        if (!cancelled) setIsDetectingBackends(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [i18n]);

  function handleComplete() {
    if (folder.trim()) {
      storageSet(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY, folder.trim());
    }
    storageSet(STORAGE_KEYS.SETUP_COMPLETE, "true");
    onComplete();
  }

  function handleSkip() {
    storageSet(STORAGE_KEYS.SETUP_COMPLETE, "true");
    onComplete();
  }

  async function handleBrowse() {
    try {
      const nextDirectory = await window.electronAPI?.openDirectory?.();
      if (!nextDirectory) return;
      setFolder(nextDirectory);
    } catch {
      /* dialog not available – user can type manually */
    }
  }

  const installedCount = BACKENDS.filter((backend) => backendStatus[backend.id]).length;
  const stepIndex = step === "backends" ? 0 : 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-md">
      <div className="w-full max-w-[720px] px-5">
        <div className="mb-5 text-center">
          <div className="text-xs text-muted-foreground mb-2">{stepIndex + 1} / 2</div>
          <h1 className="text-xl font-semibold tracking-tight mb-1.5">{t("setupWizard.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {step === "backends"
              ? t("setupWizard.backendStatusSubtitle")
              : t("setupWizard.folderSubtitle")}
          </p>
        </div>

        <div className="flex justify-center gap-1.5 mb-5">
          {[0, 1].map((idx) => (
            <div
              key={idx}
              className={[
                "h-1.5 rounded-full transition-all duration-300",
                idx === stepIndex
                  ? "w-8 bg-foreground"
                  : idx < stepIndex
                    ? "w-4 bg-foreground/60"
                    : "w-4 bg-muted",
              ].join(" ")}
            />
          ))}
        </div>

        {step === "backends" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border bg-card px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {isDetectingBackends
                  ? t("setupWizard.detectingBackends")
                  : t("setupWizard.detectedBackends", { count: installedCount })}
              </span>
              {isDetectingBackends && (
                <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {BACKENDS.map((backend) => {
                const installed = backendStatus[backend.id];
                const installState = installStates[backend.id] ?? "idle";
                const log = installLogs[backend.id];
                const Icon = backend.Icon;

                return (
                  <div key={backend.id} className="rounded-xl border bg-card p-4 shadow-sm">
                    <div className="flex items-start gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                        <Icon className="size-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <h2 className="font-medium leading-none">{backend.label}</h2>
                          <span
                            className={[
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                              installed
                                ? "bg-emerald-500/10 text-emerald-600"
                                : "bg-amber-500/10 text-amber-600",
                            ].join(" ")}
                          >
                            {installed ? (
                              <Check className="size-3" />
                            ) : (
                              <XCircle className="size-3" />
                            )}
                            {installed ? t("setupWizard.installed") : t("setupWizard.notInstalled")}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{backend.tagline}</p>
                      </div>
                    </div>

                    <div className="mt-3 space-y-2 text-xs">
                      <div>
                        <div className="mb-1 text-muted-foreground">
                          {t("setupWizard.requiredCommand")}
                        </div>
                        <code className="block rounded-md bg-muted px-2 py-1 font-mono text-[11px]">
                          {backend.requirement}
                        </code>
                      </div>
                      <div>
                        <div className="mb-1 text-muted-foreground">
                          {t("setupWizard.installCommand")}
                        </div>
                        <code className="block whitespace-pre-wrap select-all rounded-md bg-muted px-2 py-1 font-mono text-[11px]">
                          {backend.installCmd}
                        </code>
                      </div>
                    </div>

                    {log && (
                      <pre
                        ref={(el) => {
                          logRefs.current[backend.id] = el;
                        }}
                        className="mt-3 max-h-24 overflow-auto rounded-md bg-black/90 p-2 text-[10px] text-white"
                      >
                        {log}
                      </pre>
                    )}

                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        type="button"
                        variant={installed ? "outline" : "default"}
                        size="sm"
                        disabled={installState === "installing"}
                        onClick={() => void handleInstall(backend)}
                        className="h-8 text-xs"
                      >
                        {installState === "installing" ? (
                          <LoaderCircle className="mr-1.5 size-3 animate-spin" />
                        ) : (
                          <Download className="mr-1.5 size-3" />
                        )}
                        {installed ? t("setupWizard.reinstallCli") : t("setupWizard.installCli")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => window.electronAPI?.openExternal?.(backend.docsUrl)}
                        className="h-8 text-xs"
                      >
                        {t("setupWizard.docs")}
                        <ExternalLink className="ml-1.5 size-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step === "folder" && (
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Folder className="size-5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t("setupWizard.folderTitle")}</div>
                <p className="mt-1 text-sm text-muted-foreground">{t("setupWizard.folderHelp")}</p>
              </div>
            </div>

            <div className="mt-4 flex gap-2">
              <input
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                placeholder="~/Projects"
                className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <Button type="button" variant="outline" onClick={handleBrowse}>
                <Folder className="mr-1.5 size-4" />
                {t("common.browse")}
              </Button>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              {t("setupWizard.folderEmptyHint")}{" "}
              <span className="font-medium">{t("setupWizard.settingsGeneral")}</span>.
            </p>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            onClick={handleSkip}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("setupWizard.skipSetup")}
          </button>

          <div className="flex items-center gap-2">
            {step === "folder" && (
              <Button variant="outline" size="sm" onClick={() => setStep("backends")}>
                {t("common.back")}
              </Button>
            )}
            {step === "backends" ? (
              <Button size="sm" onClick={() => setStep("folder")}>
                {t("setupWizard.continue")}
                <ArrowRight className="ml-1.5 size-3.5" />
              </Button>
            ) : (
              <Button size="sm" onClick={handleComplete}>
                {t("setupWizard.launch")}
                <ArrowRight className="ml-1.5 size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
