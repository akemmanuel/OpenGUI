import {
  ArrowLeft,
  Bot,
  FolderKey,
  Laptop,
  Palette,
  Languages,
  MessageSquare,
  Plug,
  ScrollText,
  Settings2,
  Sparkles,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsProviders } from "@/components/SettingsProviders";
import { DesktopSettings } from "@/components/settings/DesktopSettings";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { NamedTeamsSettings } from "@/features/identity/NamedTeamsSettings";
import { TeamSettings } from "@/features/identity/TeamSettings";
import { SkillsSettings } from "@/features/skills/SkillsSettings";
import { CodexToolsSettings } from "@/features/codex-tools/CodexToolsSettings";
import { InstructionsSettings } from "@/features/instructions/InstructionsSettings";
import { McpSettings } from "@/features/mcp/McpSettings";
import { useIdentityActor } from "@/features/identity/identity-actor-context";
import { ownerSettingsVisibility } from "@/features/identity/identity-state";
import {
  getIdentityWorkspace,
  identityWorkspaceIsLocalBypass,
} from "@/features/identity/workspace-identity";
import { cn } from "@/lib/utils";
import { getDesktopShellClient } from "@/runtime/clients";
import packageJson from "../../../package.json";

export type SectionId =
  | "appearance"
  | "language"
  | "chats"
  | "models"
  | "integrations"
  | "skills"
  | "instructions"
  | "users"
  | "teams"
  | "paths"
  | "host"
  | "desktop";

import { AppearanceSettings, ChatPreferences } from "@/features/profile/PreferenceSections";
import { LanguageOptions } from "@/features/profile/PreferenceControls";

type Section = { id: SectionId; icon: LucideIcon; visible: boolean };
type Group = { id: "personal" | "agent" | "host" | "device"; sections: Section[] };

export function SettingsView({
  onBack,
  initialTab,
  showModelConnections,
  backToSetup,
}: {
  onBack: () => void;
  initialTab?: SectionId;
  showModelConnections?: boolean;
  backToSetup?: boolean;
}) {
  const { t } = useTranslation();
  const backLabel = t("settings.backToChat");
  const [requestedTab, setActiveTab] = useState<SectionId | null>(initialTab ?? "models");
  const [dirty, setDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState<SectionId | "back" | null>(null);

  const workspace = getIdentityWorkspace();
  const actor = useIdentityActor();
  const localBypass = !!workspace && identityWorkspaceIsLocalBypass(workspace);
  const ownerTabs = ownerSettingsVisibility(actor, localBypass);
  const showOwnerTabs = localBypass || actor?.type === "user";
  const showTeam = ownerTabs.team && !!workspace?.authToken;
  const showHostAdmin = showTeam && actor?.type === "user" && actor.role === "owner";
  const showMcp =
    localBypass || (actor?.type === "user" && (actor.role === "owner" || actor.role === "admin"));
  const isDesktop = getDesktopShellClient().runtime.isElectron;

  const groups: Group[] = (
    [
      {
        id: "personal",
        sections: [
          { id: "appearance", icon: Palette, visible: true },
          { id: "language", icon: Languages, visible: true },
          { id: "chats", icon: MessageSquare, visible: true },
        ],
      },
      {
        id: "agent",
        sections: [
          { id: "models", icon: Bot, visible: showOwnerTabs },
          { id: "integrations", icon: Plug, visible: showMcp },
          { id: "skills", icon: Sparkles, visible: true },
          { id: "instructions", icon: ScrollText, visible: true },
        ],
      },
      {
        id: "host",
        sections: [
          { id: "users", icon: UserRound, visible: showTeam },
          { id: "teams", icon: Users, visible: showTeam },
          { id: "paths", icon: FolderKey, visible: showTeam },
          { id: "host", icon: Settings2, visible: showHostAdmin },
        ],
      },
      {
        id: "device",
        sections: [{ id: "desktop", icon: Laptop, visible: isDesktop }],
      },
    ] satisfies Group[]
  )
    .map((group) => ({ ...group, sections: group.sections.filter((item) => item.visible) }))
    .filter((group) => group.sections.length > 0);
  const visibleIds = groups.flatMap((group) => group.sections.map((section) => section.id));
  const activeTab: SectionId =
    requestedTab && visibleIds.includes(requestedTab) ? requestedTab : (visibleIds[0] ?? "skills");

  function navigate(tab: SectionId | "back") {
    if (tab === activeTab) return;
    if (dirty) {
      setPendingTab(tab);
      return;
    }
    if (tab === "back") onBack();
    else setActiveTab(tab);
  }

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (backToSetup) {
    return (
      <section className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-6 px-5 py-5 sm:px-8 sm:py-8">
          <Button variant="ghost" size="lg" onClick={onBack}>
            <ArrowLeft />
            {t("settings.backToSetup")}
          </Button>
          <SettingsProviders setupMode />
        </div>
      </section>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <AlertDialog
        open={pendingTab !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTab(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("access.discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("access.discardHelp")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("access.keepEditing")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDirty(false);
                if (pendingTab === "back") onBack();
                else if (pendingTab) setActiveTab(pendingTab);
                setPendingTab(null);
              }}
            >
              {t("access.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <nav
        aria-label={t("settings.navigationLabel")}
        className="flex shrink-0 flex-col border-b bg-sidebar md:w-64 md:border-r md:border-b-0"
      >
        <div className="flex items-center gap-2 px-3 py-3 md:gap-3 md:px-4 md:pt-5 md:pb-4">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => navigate("back")}
            aria-label={backLabel}
            title={backLabel}
            className="size-10 text-muted-foreground"
          >
            <ArrowLeft />
          </Button>
          <h1 className="mr-auto text-lg font-semibold tracking-tight">{t("common.settings")}</h1>
          <div className="min-w-0 md:hidden">
            <Select value={activeTab} onValueChange={(value) => navigate(value as SectionId)}>
              <SelectTrigger
                id="settings-section"
                aria-label={t("settings.navigationLabel")}
                className="h-10 w-auto max-w-[48vw] gap-2 bg-card"
              >
                <SelectValue>{t(`settings.tabs.${activeTab}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {groups.map((group) => (
                  <SelectGroup key={group.id}>
                    <SelectLabel>{t(`settings.groups.${group.id}`)}</SelectLabel>
                    {group.sections.map((section) => (
                      <SelectItem key={section.id} value={section.id} className="min-h-10">
                        {t(`settings.tabs.${section.id}`)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="hidden min-h-0 flex-1 overflow-y-auto px-3 pb-4 md:block">
          {groups.map((group) => (
            <div key={group.id} className="mt-5 first:mt-0">
              {groups.length > 1 && (
                <h2 className="px-2.5 pb-1.5 text-xs font-semibold text-muted-foreground">
                  {t(`settings.groups.${group.id}`)}
                </h2>
              )}
              <ul className="space-y-0.5">
                {group.sections.map((section) => {
                  const active = activeTab === section.id;
                  return (
                    <li key={section.id}>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "min-h-9 w-full justify-start gap-2.5 px-2.5 text-left font-medium",
                          active
                            ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground hover:bg-sidebar-accent"
                            : "text-muted-foreground",
                        )}
                        onClick={() => navigate(section.id)}
                      >
                        <section.icon
                          className={active ? "text-primary" : undefined}
                          aria-hidden="true"
                        />
                        {t(`settings.tabs.${section.id}`)}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <p className="hidden px-5 py-4 text-xs text-muted-foreground md:block">
          {t("settings.version", { version: packageJson.version })}
        </p>
      </nav>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-5 py-6 sm:px-9 md:py-10 xl:px-12">
          <header className="mb-6 space-y-2.5 border-b pb-5 wrap-anywhere md:mb-8 md:pb-6">
            <h2 className="text-2xl leading-tight font-semibold tracking-tight md:text-[2rem]">
              {t(`settings.tabs.${activeTab}`)}
            </h2>
            {activeTab !== "models" && activeTab !== "instructions" && (
              <p className="max-w-[65ch] text-sm leading-6 text-muted-foreground">
                {t(`settings.sectionDescriptions.${activeTab}`)}
              </p>
            )}
          </header>
          {activeTab === "appearance" && <AppearanceSettings />}
          {activeTab === "language" && <LanguageOptions />}
          {activeTab === "chats" && <ChatPreferences />}
          {activeTab === "models" && (
            <SettingsProviders
              onDirtyChange={setDirty}
              initialShowConnections={showModelConnections}
            />
          )}
          {activeTab === "integrations" && (
            <div className="space-y-8">
              <CodexToolsSettings />
              <section className="border-t pt-6">
                <McpSettings />
              </section>
            </div>
          )}
          {activeTab === "skills" && <SkillsSettings />}
          {activeTab === "instructions" && <InstructionsSettings onDirtyChange={setDirty} />}
          {activeTab === "users" && <TeamSettings view="people" />}
          {activeTab === "teams" && <NamedTeamsSettings onDirtyChange={setDirty} />}
          {activeTab === "paths" && (
            <div className="space-y-6">
              <div className="rounded-lg bg-muted/40 p-3 text-sm leading-6">
                <p className="font-medium">{t("settings.paths.boundaryTitle")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.paths.boundaryDescription")}
                </p>
              </div>
              <TeamSettings view="paths" />
            </div>
          )}
          {activeTab === "host" && <TeamSettings view="host" />}
          {activeTab === "desktop" && <DesktopSettings />}
        </div>
      </main>
    </div>
  );
}
